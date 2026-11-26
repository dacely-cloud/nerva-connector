// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Captured start eligibility is checked again after trusted setup, without limiting an already-executed payload's lifetime.

use serde::{Deserialize, Deserializer, Serializer};
use std::io;

pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(serde::de::Error::custom("Invalid captured launch expiry"));
    }
    let expiry: u64 = value.parse().map_err(serde::de::Error::custom)?;
    if expiry > i64::MAX as u64 {
        return Err(serde::de::Error::custom(
            "Captured launch expiry exceeds its bound",
        ));
    }
    Ok(expiry)
}

/// This pre-exec callback uses only the host clock, integer operations and inline OS errors: no allocation, locks or environment access.
pub fn remaining_ms(expires_at_ms: u64) -> io::Result<u64> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: CLOCK_REALTIME is fixed and this initialized exact structure belongs solely to the current process.
    if unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut time) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if time.tv_sec < 0 || !(0..1_000_000_000).contains(&time.tv_nsec) {
        return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
    }
    let now = (time.tv_sec as u128) * 1000 + (time.tv_nsec as u128) / 1_000_000;
    if expires_at_ms == 0 || expires_at_ms > i64::MAX as u64 || now >= expires_at_ms as u128 {
        return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
    }
    Ok((expires_at_ms as u128 - now) as u64)
}

/// The same host clock governs captured eligibility at each native effect boundary.
pub fn check(expires_at_ms: u64) -> io::Result<()> {
    remaining_ms(expires_at_ms).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_expiry_is_closed_and_the_host_clock_is_checked() {
        assert!(check(0).is_err());
        assert!(check(1).is_err());
        assert!(check(i64::MAX as u64).is_ok());
        assert!(check(u64::MAX).is_err());
    }
}
