// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! The namespace-local guardian owns one confined payload and one bounded application input pipe.

use super::pipe_broker::{Broker, nonblocking, poll};
use super::pipe_input::{Admission, Input};
use super::pipe_process::Payload;
use super::pipe_protocol::{Event, digest};
use super::runtime_input::{PreparedInput, RuntimeInput};
use super::{SetupFailure, configuration::Configuration, confinement, execute, pipe_mac, syscalls};
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};

fn application_pipe() -> io::Result<(File, File)> {
    let mut descriptors = [-1; 2];
    // SAFETY: The initialized two-descriptor array receives a new private close-on-exec application pipe.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Successful pipe2 returned two distinct fresh descriptors owned by these Files.
    let read = unsafe { File::from_raw_fd(descriptors[0]) };
    // SAFETY: The second fresh descriptor is independently transferred exactly once.
    let write = unsafe { File::from_raw_fd(descriptors[1]) };
    nonblocking(write.as_raw_fd())?;
    Ok((read, write))
}

pub fn run(value: Configuration) -> Result<(), SetupFailure> {
    let RuntimeInput::Pipe {
        incarnation,
        stdin,
        guardian_profile,
        maximum_input_bytes,
        maximum_controls,
        execution_deadline_ms,
        ..
    } = &value.input
    else {
        return Err(SetupFailure::Configuration);
    };
    pipe_mac::guardian(&value.apparmor_profile, guardian_profile)
        .map_err(|_| SetupFailure::Apparmor)?;
    let mut broker = Broker::open().map_err(|_| SetupFailure::Configuration)?;
    for descriptor in 3..8 {
        // SAFETY: Inherited nonstandard bootstrap capabilities are no longer needed after mounts and strict configuration admission.
        unsafe {
            libc::close(descriptor);
        }
    }
    let (read, write) = application_pipe().map_err(|_| SetupFailure::Configuration)?;
    // Payload must stop and join before this writer drops on every early return, including Ready/reporting failure.
    let mut writer = Some(write);
    let mut payload = Payload::spawn(
        || {
            // SAFETY: The fork child owns this pipe read end; fd zero receives an independent application-only reference.
            if unsafe { libc::dup2(read.as_raw_fd(), libc::STDIN_FILENO) } != libc::STDIN_FILENO {
                return Err(SetupFailure::Configuration);
            }
            PreparedInput::prepare(&value.input)
                .and_then(PreparedInput::install)
                .map_err(|_| SetupFailure::Configuration)?;
            pipe_mac::payload(&value.apparmor_profile, guardian_profile)
                .map_err(|_| SetupFailure::Apparmor)?;
            confinement::prepare(&value).map_err(|_| SetupFailure::Confinement)
        },
        || {
            syscalls::install().map_err(|_| SetupFailure::Confinement)?;
            execute(&value)
        },
    )
    .map_err(|_| SetupFailure::Execute)?;
    drop(read);
    let mut input = Input::new(
        incarnation.clone(),
        stdin.as_bytes().to_vec(),
        super::pipe_protocol::quantity(maximum_input_bytes, super::pipe_protocol::TOTAL_BYTES)
            .map_err(|_| SetupFailure::Configuration)?,
        *maximum_controls,
        *execution_deadline_ms,
    );
    broker
        .send(
            &Event::Ready {
                incarnation,
                initial_input_bytes: stdin.len(),
                initial_input_hash: digest(stdin.as_bytes()),
            },
            *execution_deadline_ms,
        )
        .map_err(|_| SetupFailure::Execute)?;
    let result = serve(
        &mut broker,
        &mut payload,
        &mut writer,
        &mut input,
        incarnation,
        *execution_deadline_ms,
    );
    match result {
        Ok(status) => finish(status),
        Err(_) => Err(SetupFailure::Execute),
    }
}

/// Expiry cannot block native cleanup on reporting, and a negative event never describes partial bytes as confirmed.
fn cutoff(
    broker: &mut Broker,
    payload: &mut Payload,
    input: &Input,
    deadline: u64,
    announce: bool,
) -> io::Result<()> {
    if let Err(error) = super::launch_window::check(deadline) {
        payload.stop()?;
        if error.raw_os_error() == Some(libc::ETIMEDOUT) {
            if super::launch_window::check(input.original_deadline())
                .is_err_and(|failure| failure.raw_os_error() == Some(libc::ETIMEDOUT))
            {
                broker.notify_expired(&input.timed_out());
            } else if announce && let Ok(event) = input.expired() {
                broker.notify_expired(&event);
            }
        }
        return Err(error);
    }
    Ok(())
}

fn serve(
    broker: &mut Broker,
    payload: &mut Payload,
    writer: &mut Option<File>,
    input: &mut Input,
    incarnation: &str,
    execution_deadline_ms: u64,
) -> io::Result<i32> {
    loop {
        if let Some(status) = payload.try_status()? {
            payload.stop()?;
            return Ok(status);
        }
        let pending = input.pending_expiry();
        let deadline = pending.unwrap_or(execution_deadline_ms);
        cutoff(broker, payload, input, deadline, pending.is_some())?;
        let mut entries = [
            libc::pollfd {
                fd: broker.descriptor(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: writer.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: if input.remaining().is_some() {
                    libc::POLLOUT
                } else {
                    0
                },
                revents: 0,
            },
            libc::pollfd {
                fd: payload.descriptor(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if broker.buffered() {
            entries[0].revents = libc::POLLIN;
        } else if let Err(error) = poll(&mut entries, deadline) {
            cutoff(broker, payload, input, deadline, pending.is_some())?;
            return Err(error);
        }
        cutoff(broker, payload, input, deadline, pending.is_some())?;
        if entries[0].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(super::configuration::invalid());
        }
        if entries[0].revents & libc::POLLIN != 0 {
            // One finite frame per turn prevents duplicate input from starving effect deadlines.
            if let Some(command) = broker.receive(incarnation, deadline)? {
                match input.admit(command)? {
                    Admission::Applied => broker.send(&input.receipt()?, execution_deadline_ms)?,
                    Admission::End => {
                        let expiry = input
                            .pending_expiry()
                            .ok_or_else(super::configuration::invalid)?;
                        cutoff(broker, payload, input, expiry, true)?;
                        drop(writer.take());
                        cutoff(broker, payload, input, expiry, true)?;
                        input.end()?;
                        broker.send(&input.receipt()?, execution_deadline_ms)?;
                    }
                    Admission::Empty => {
                        let expiry = input
                            .pending_expiry()
                            .ok_or_else(super::configuration::invalid)?;
                        cutoff(broker, payload, input, expiry, true)?;
                        input.empty()?;
                        cutoff(broker, payload, input, expiry, true)?;
                        broker.send(&input.receipt()?, execution_deadline_ms)?;
                    }
                    Admission::Pending => {}
                }
            }
        }
        if let Some(bytes) = input.remaining() {
            let expiry = input
                .pending_expiry()
                .ok_or_else(super::configuration::invalid)?;
            cutoff(broker, payload, input, expiry, true)?;
            let output = writer.as_mut().ok_or_else(super::configuration::invalid)?;
            let result = output.write(bytes);
            cutoff(broker, payload, input, expiry, true)?;
            match result {
                Ok(count) => {
                    if input.wrote(count)? {
                        broker.send(&input.receipt()?, execution_deadline_ms)?;
                    }
                }
                Err(error)
                    if error.kind() == io::ErrorKind::Interrupted
                        || error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
    }
}

fn finish(status: i32) -> ! {
    if libc::WIFEXITED(status) {
        std::process::exit(libc::WEXITSTATUS(status));
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: Only this trusted guardian's core limit/disposition changes; its kernel-observed child signal is reflected on itself.
        unsafe {
            libc::setrlimit(libc::RLIMIT_CORE, &limit);
            libc::signal(signal, libc::SIG_DFL);
            libc::raise(signal);
        }
    }
    std::process::exit(125)
}
