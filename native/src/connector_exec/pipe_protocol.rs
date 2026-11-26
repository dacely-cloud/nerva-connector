// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! The fixed local control descriptor carries data/EOF only, after the signed owner has authorized them.

use super::configuration::invalid;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io;

pub const FRAME_BYTES: usize = 4096;
pub const TOTAL_BYTES: u64 = 65536;
pub const CONTROLS: u64 = 256;
pub const ENCODED_BYTES: usize = 8192;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Data {
        incarnation: String,
        input_sequence: String,
        offset: String,
        input_hash: String,
        delivery_expires_at_ms: String,
        data_hash: String,
        byte_length: String,
        data_base64: String,
    },
    End {
        incarnation: String,
        input_sequence: String,
        offset: String,
        input_hash: String,
        delivery_expires_at_ms: String,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Event<'a> {
    Ready {
        incarnation: &'a str,
        initial_input_bytes: usize,
        initial_input_hash: String,
    },
    TimedOut {
        incarnation: &'a str,
    },
    Expired {
        incarnation: &'a str,
        input_sequence: &'a str,
        input_hash: &'a str,
        confirmed_offset: String,
    },
    Applied {
        incarnation: &'a str,
        input_sequence: &'a str,
        input_hash: &'a str,
        accepted_offset: String,
        ended: bool,
    },
}

pub struct Decoded {
    pub command: Command,
    pub sequence: u64,
    pub offset: u64,
    pub delivery_expires_at_ms: u64,
    pub bytes: Option<Vec<u8>>,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn quantity(value: &str, maximum: u64) -> io::Result<u64> {
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid());
    }
    let number: u64 = value.parse().map_err(|_| invalid())?;
    if number > maximum {
        return Err(invalid());
    }
    Ok(number)
}

impl Command {
    pub fn identity(&self) -> (&str, &str, &str, &str) {
        match self {
            Self::Data {
                incarnation,
                input_sequence,
                offset,
                input_hash,
                ..
            }
            | Self::End {
                incarnation,
                input_sequence,
                offset,
                input_hash,
                ..
            } => (incarnation, input_sequence, offset, input_hash),
        }
    }

    pub fn expiry(&self) -> &str {
        match self {
            Self::Data {
                delivery_expires_at_ms,
                ..
            }
            | Self::End {
                delivery_expires_at_ms,
                ..
            } => delivery_expires_at_ms,
        }
    }

    /// Wrapper renewal cannot change any stable input byte or extend an already-pending local delivery.
    pub fn same_input(&self, other: &Self) -> bool {
        if self.identity() != other.identity() {
            return false;
        }
        match (self, other) {
            (
                Self::Data {
                    data_hash,
                    byte_length,
                    data_base64,
                    ..
                },
                Self::Data {
                    data_hash: other_hash,
                    byte_length: other_length,
                    data_base64: other_data,
                    ..
                },
            ) => {
                data_hash == other_hash && byte_length == other_length && data_base64 == other_data
            }
            (Self::End { .. }, Self::End { .. }) => true,
            _ => false,
        }
    }
}

pub fn decode(bytes: &[u8], expected: &str) -> io::Result<Decoded> {
    if bytes.len() > ENCODED_BYTES {
        return Err(invalid());
    }
    let command: Command = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let (incarnation, sequence, offset, input_hash) = command.identity();
    if incarnation != expected || !hash(incarnation) || !hash(input_hash) {
        return Err(invalid());
    }
    let delivery_expires_at_ms = quantity(command.expiry(), i64::MAX as u64)?;
    if delivery_expires_at_ms == 0 {
        return Err(invalid());
    }
    let sequence = quantity(sequence, CONTROLS - 1)?;
    let offset = quantity(offset, TOTAL_BYTES)?;
    let data = match &command {
        Command::Data {
            data_hash,
            byte_length,
            data_base64,
            ..
        } => {
            if !hash(data_hash) || data_base64.len() > FRAME_BYTES.div_ceil(3) * 4 {
                return Err(invalid());
            }
            let bytes = STANDARD.decode(data_base64).map_err(|_| invalid())?;
            if bytes.len() > FRAME_BYTES
                || STANDARD.encode(&bytes) != *data_base64
                || quantity(byte_length, FRAME_BYTES as u64)? != bytes.len() as u64
                || digest(&bytes) != *data_hash
                || offset + bytes.len() as u64 > TOTAL_BYTES
                || (sequence > 0 && bytes.is_empty())
            {
                return Err(invalid());
            }
            Some(bytes)
        }
        Command::End { .. } => {
            if sequence == 0 {
                return Err(invalid());
            }
            None
        }
    };
    Ok(Decoded {
        command,
        sequence,
        offset,
        delivery_expires_at_ms,
        bytes: data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn data() -> Value {
        json!({
            "kind": "data",
            "incarnation": "a".repeat(64),
            "inputSequence": "0",
            "offset": "0",
            "deliveryExpiresAtMs": "9223372036854775807",
            "inputHash": "b".repeat(64),
            "dataHash": digest(b"a\0b"),
            "byteLength": "3",
            "dataBase64": STANDARD.encode(b"a\0b")
        })
    }

    #[test]
    fn data_is_exact_binary_and_quantities_are_canonical() {
        let value = data();
        assert_eq!(
            decode(&serde_json::to_vec(&value).unwrap(), &"a".repeat(64))
                .unwrap()
                .bytes
                .unwrap(),
            b"a\0b"
        );
        for (field, replacement) in [
            ("inputSequence", json!("00")),
            ("offset", json!("65537")),
            ("byteLength", json!("2")),
            ("dataHash", json!("0".repeat(64))),
            ("dataBase64", json!("YR==")),
            ("incarnation", json!("c".repeat(64))),
        ] {
            let mut changed = value.clone();
            changed[field] = replacement;
            assert!(decode(&serde_json::to_vec(&changed).unwrap(), &"a".repeat(64)).is_err());
        }
    }

    #[test]
    fn variant_bounds_and_initial_empty_record_are_explicit() {
        let mut value = data();
        value["dataBase64"] = json!("");
        value["dataHash"] = json!(digest(b""));
        value["byteLength"] = json!("0");
        assert!(decode(&serde_json::to_vec(&value).unwrap(), &"a".repeat(64)).is_ok());
        value["inputSequence"] = json!("1");
        assert!(decode(&serde_json::to_vec(&value).unwrap(), &"a".repeat(64)).is_err());
        let end = json!({
            "kind": "end",
            "incarnation": "a".repeat(64),
            "inputSequence": "1",
            "offset": "65536",
            "deliveryExpiresAtMs": "9223372036854775807",
            "inputHash": "b".repeat(64)
        });
        assert!(decode(&serde_json::to_vec(&end).unwrap(), &"a".repeat(64)).is_ok());
        let mut changed = end;
        changed["dataBase64"] = json!("");
        assert!(decode(&serde_json::to_vec(&changed).unwrap(), &"a".repeat(64)).is_err());
        assert!(decode(&vec![b' '; ENCODED_BYTES + 1], &"a".repeat(64)).is_err());
    }
}
