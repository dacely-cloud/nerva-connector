// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Distinct explicit Pipe labels never reinterpret the ordinary two-profile admission contract.

use super::configuration::invalid;
use std::fs::File;
use std::io::{self, Read};

fn label(expected: &[&str]) -> io::Result<()> {
    let mut bytes = Vec::new();
    File::open("/proc/self/attr/current")?
        .take(513)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 512 {
        return Err(invalid());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    let value = text.trim().strip_suffix(" (enforce)").ok_or_else(invalid)?;
    let mut names: Vec<&str> = value.split("//&").collect();
    names.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if names != expected {
        return Err(invalid());
    }
    Ok(())
}

pub fn guardian(profile: &str, guard: &str) -> io::Result<()> {
    let launcher = profile.replacen("nerva-connector-exec-", "nerva-connector-launch-", 1);
    label(&[&launcher])?;
    std::fs::write("/proc/self/attr/current", format!("stack {guard}"))?;
    label(&[guard, &launcher])
}

pub fn payload(profile: &str, guard: &str) -> io::Result<()> {
    let launcher = profile.replacen("nerva-connector-exec-", "nerva-connector-launch-", 1);
    label(&[guard, &launcher])?;
    std::fs::write("/proc/self/attr/current", format!("stack {profile}"))?;
    label(&[profile, guard, &launcher])
}
