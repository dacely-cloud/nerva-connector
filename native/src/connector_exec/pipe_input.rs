// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! A single native writer retains its exact pending command and never resends an accepted byte prefix.

use super::configuration::invalid;
use super::pipe_protocol::{Command, Decoded, Event};
use std::io;

struct Pending {
    decoded: Decoded,
    written: usize,
}

pub enum Admission {
    Pending,
    Applied,
    End,
    Empty,
}

pub struct Input {
    incarnation: String,
    initial: Vec<u8>,
    next: u64,
    accepted: u64,
    initial_accepted: bool,
    ended: bool,
    pending: Option<Pending>,
    last: Option<Command>,
    maximum_input_bytes: u64,
    maximum_controls: u64,
    execution_deadline_ms: u64,
}

impl Input {
    pub fn new(
        incarnation: String,
        initial: Vec<u8>,
        maximum_input_bytes: u64,
        maximum_controls: u64,
        execution_deadline_ms: u64,
    ) -> Self {
        Self {
            incarnation,
            initial,
            next: 0,
            accepted: 0,
            initial_accepted: false,
            ended: false,
            pending: None,
            last: None,
            maximum_input_bytes,
            maximum_controls,
            execution_deadline_ms,
        }
    }

    pub fn admit(&mut self, decoded: Decoded) -> io::Result<Admission> {
        if decoded.delivery_expires_at_ms > self.execution_deadline_ms {
            return Err(invalid());
        }
        if let Some(pending) = &self.pending {
            return if pending.decoded.command.same_input(&decoded.command) {
                Ok(Admission::Pending)
            } else {
                Err(invalid())
            };
        }
        if self
            .last
            .as_ref()
            .is_some_and(|command| command.same_input(&decoded.command))
        {
            return Ok(Admission::Applied);
        }
        if self.ended
            || decoded.sequence >= self.maximum_controls
            || decoded.offset + decoded.bytes.as_ref().map_or(0, |bytes| bytes.len() as u64)
                > self.maximum_input_bytes
            || decoded.sequence != self.next
            || decoded.offset != self.accepted
            || (!self.initial_accepted
                && (decoded.sequence != 0 || decoded.bytes.as_ref() != Some(&self.initial)))
        {
            return Err(invalid());
        }
        if decoded.bytes.is_none() {
            self.pending = Some(Pending {
                decoded,
                written: 0,
            });
            return Ok(Admission::End);
        }
        let empty = decoded.bytes.as_ref().is_some_and(Vec::is_empty);
        self.pending = Some(Pending {
            decoded,
            written: 0,
        });
        if empty {
            return Ok(Admission::Empty);
        }
        Ok(Admission::Pending)
    }

    pub fn original_deadline(&self) -> u64 {
        self.execution_deadline_ms
    }
    pub fn timed_out(&self) -> Event<'_> {
        Event::TimedOut {
            incarnation: &self.incarnation,
        }
    }

    pub fn pending_expiry(&self) -> Option<u64> {
        self.pending
            .as_ref()
            .map(|value| value.decoded.delivery_expires_at_ms)
    }

    pub fn empty(&mut self) -> io::Result<()> {
        if self.remaining() != Some(&[]) {
            return Err(invalid());
        }
        self.complete()
    }

    /// Physical partial bytes cannot advance this negative event's fully confirmed lower bound.
    pub fn expired(&self) -> io::Result<Event<'_>> {
        let command = self
            .pending
            .as_ref()
            .map(|value| &value.decoded.command)
            .or(self.last.as_ref())
            .ok_or_else(invalid)?;
        let (_, sequence, offset, hash) = command.identity();
        Ok(Event::Expired {
            incarnation: &self.incarnation,
            input_sequence: sequence,
            input_hash: hash,
            confirmed_offset: offset.to_string(),
        })
    }

    pub fn remaining(&self) -> Option<&[u8]> {
        let pending = self.pending.as_ref()?;
        Some(&pending.decoded.bytes.as_ref()?[pending.written..])
    }

    pub fn wrote(&mut self, count: usize) -> io::Result<bool> {
        let pending = self.pending.as_mut().ok_or_else(invalid)?;
        let bytes = pending.decoded.bytes.as_ref().ok_or_else(invalid)?;
        if count == 0 || count > bytes.len() - pending.written {
            return Err(invalid());
        }
        pending.written += count;
        self.accepted += count as u64;
        if pending.written == bytes.len() {
            self.complete()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn end(&mut self) -> io::Result<()> {
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.decoded.bytes.is_some())
        {
            return Err(invalid());
        }
        self.ended = true;
        self.complete()
    }

    pub fn receipt(&self) -> io::Result<Event<'_>> {
        let command = self.last.as_ref().ok_or_else(invalid)?;
        let (_, input_sequence, _, input_hash) = command.identity();
        Ok(Event::Applied {
            incarnation: &self.incarnation,
            input_sequence,
            input_hash,
            accepted_offset: self.accepted.to_string(),
            ended: self.ended,
        })
    }

    fn complete(&mut self) -> io::Result<()> {
        let pending = self.pending.take().ok_or_else(invalid)?;
        if pending.decoded.sequence == 0 {
            self.initial_accepted = true;
        }
        self.next += 1;
        self.last = Some(pending.decoded.command);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::pipe_protocol::{decode, digest};
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde_json::json;

    fn data(sequence: u64, offset: u64, bytes: &[u8]) -> Decoded {
        decode(
            &serde_json::to_vec(&json!({
                "kind": "data",
                "incarnation": "a".repeat(64),
                "inputSequence": sequence.to_string(),
                "offset": offset.to_string(),
                "deliveryExpiresAtMs": "9223372036854775807",
                "inputHash": digest(&[sequence as u8]),
                "dataHash": digest(bytes),
                "byteLength": bytes.len().to_string(),
                "dataBase64": STANDARD.encode(bytes)
            }))
            .unwrap(),
            &"a".repeat(64),
        )
        .unwrap()
    }

    #[test]
    fn partial_write_and_retry_only_retain_the_unaccepted_suffix() {
        let mut input = Input::new(
            "a".repeat(64),
            b"a\0b".to_vec(),
            65536,
            256,
            i64::MAX as u64,
        );
        assert!(matches!(
            input.admit(data(0, 0, b"a\0b")).unwrap(),
            Admission::Pending
        ));
        assert!(!input.wrote(1).unwrap());
        assert_eq!(input.remaining().unwrap(), b"\0b");
        assert!(matches!(
            input.admit(data(0, 0, b"a\0b")).unwrap(),
            Admission::Pending
        ));
        assert_eq!(input.remaining().unwrap(), b"\0b");
        assert!(input.wrote(2).unwrap());
        assert!(matches!(
            input.admit(data(0, 0, b"a\0b")).unwrap(),
            Admission::Applied
        ));
        assert!(input.remaining().is_none());
        assert_eq!(input.accepted, 3);
        assert!(input.initial_accepted);
        assert!(input.admit(data(1, 0, b"c")).is_err());
        assert!(matches!(
            input.admit(data(1, 3, b"c")).unwrap(),
            Admission::Pending
        ));
    }

    #[test]
    fn exact_initial_empty_record_then_ordered_eof_cannot_accept_more_data() {
        let mut input = Input::new("a".repeat(64), vec![], 65536, 256, i64::MAX as u64);
        assert!(input.admit(data(1, 0, b"x")).is_err());
        assert!(matches!(
            input.admit(data(0, 0, b"")).unwrap(),
            Admission::Empty
        ));
        assert!(!input.initial_accepted);
        input.empty().unwrap();
        assert!(input.initial_accepted);
        assert_eq!(input.accepted, 0);
        let end = || {
            decode(
                &serde_json::to_vec(&json!({
                    "kind": "end",
                    "incarnation": "a".repeat(64),
                    "inputSequence": "1",
                    "offset": "0",
                    "deliveryExpiresAtMs": "9223372036854775807",
                    "inputHash": "c".repeat(64)
                }))
                .unwrap(),
                &"a".repeat(64),
            )
            .unwrap()
        };
        assert!(matches!(input.admit(end()).unwrap(), Admission::End));
        input.end().unwrap();
        assert!(matches!(input.admit(end()).unwrap(), Admission::Applied));
        assert!(input.admit(data(2, 0, b"x")).is_err());
    }

    #[test]
    fn captured_limits_tighten_hard_bounds_without_invalidating_an_exact_receipt_retry() {
        let mut input = Input::new("a".repeat(64), b"a".to_vec(), 1, 2, i64::MAX as u64);
        assert!(matches!(
            input.admit(data(0, 0, b"a")).unwrap(),
            Admission::Pending
        ));
        assert!(input.wrote(1).unwrap());
        assert!(matches!(
            input.admit(data(0, 0, b"a")).unwrap(),
            Admission::Applied
        ));
        assert!(input.admit(data(1, 1, b"b")).is_err());
        let mut count = Input::new("a".repeat(64), vec![], 65536, 1, i64::MAX as u64);
        assert!(matches!(
            count.admit(data(0, 0, b"")).unwrap(),
            Admission::Empty
        ));
        count.empty().unwrap();
        assert!(count.admit(data(1, 0, b"x")).is_err());
    }
    fn expiry(mut value: Decoded, expiry: u64) -> Decoded {
        value.delivery_expires_at_ms = expiry;
        match &mut value.command {
            Command::Data {
                delivery_expires_at_ms,
                ..
            }
            | Command::End {
                delivery_expires_at_ms,
                ..
            } => *delivery_expires_at_ms = expiry.to_string(),
        }
        value
    }

    #[test]
    fn renewed_wrapper_cannot_extend_pending_cutoff_or_change_exact_bytes() {
        let mut input = Input::new("a".repeat(64), b"abc".to_vec(), 65536, 256, 1000);
        assert!(matches!(
            input.admit(expiry(data(0, 0, b"abc"), 100)).unwrap(),
            Admission::Pending
        ));
        input.wrote(1).unwrap();
        assert!(matches!(
            input.admit(expiry(data(0, 0, b"abc"), 200)).unwrap(),
            Admission::Pending
        ));
        assert_eq!(input.pending_expiry(), Some(100));
        assert_eq!(input.remaining(), Some(&b"bc"[..]));
        assert!(input.admit(expiry(data(0, 0, b"axc"), 200)).is_err());
        let event = serde_json::to_value(input.expired().unwrap()).unwrap();
        assert_eq!(event["confirmedOffset"], "0");
        assert!(event.get("ended").is_none());
        assert_eq!(input.next, 0);
        input.wrote(2).unwrap();
        let receipt = serde_json::to_vec(&input.receipt().unwrap()).unwrap();
        assert!(matches!(
            input.admit(expiry(data(0, 0, b"abc"), 50)).unwrap(),
            Admission::Applied
        ));
        assert_eq!(
            serde_json::to_vec(&input.receipt().unwrap()).unwrap(),
            receipt
        );
        assert!(input.admit(expiry(data(0, 0, b"abc"), 1001)).is_err());
    }
}
