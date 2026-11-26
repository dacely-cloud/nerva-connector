// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::io;

pub const MAXIMUM_LAUNCH: usize = 131_072;
pub const MAXIMUM_CONTROL: usize = 4096;
pub const MAXIMUM_PENDING: usize = 262_144;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub token: String,
    pub executable: String,
    pub arguments: Vec<String>,
    pub windows_verbatim_arguments: bool,
    pub cols: u16,
    pub rows: u16,
}

impl Launch {
    pub fn validate(&self) -> io::Result<Vec<CString>> {
        token(&self.token)?;
        geometry(self.cols, self.rows)?;
        if self.windows_verbatim_arguments
            || self.executable.is_empty()
            || self.executable.len() > 32_767
            || self.arguments.len() > 1024
        {
            return Err(invalid());
        }
        let mut bytes = self.executable.len();
        let mut arguments = Vec::with_capacity(self.arguments.len() + 1);
        arguments.push(CString::new(self.executable.as_str()).map_err(|_| invalid())?);
        for value in &self.arguments {
            bytes = bytes.checked_add(value.len()).ok_or_else(invalid)?;
            if value.len() > 32_767 || bytes > MAXIMUM_LAUNCH {
                return Err(invalid());
            }
            arguments.push(CString::new(value.as_str()).map_err(|_| invalid())?);
        }
        Ok(arguments)
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Control {
    Resize {
        token: String,
        id: String,
        cols: u16,
        rows: u16,
    },
    Stop {
        token: String,
        id: String,
    },
}

impl Control {
    pub fn validate(&self, expected: &str) -> io::Result<()> {
        let (supplied, id) = match self {
            Self::Resize {
                token,
                id,
                cols,
                rows,
            } => {
                geometry(*cols, *rows)?;
                (token, id)
            }
            Self::Stop { token, id } => (token, id),
        };
        if supplied != expected || id.is_empty() || id.len() > 19 || id.starts_with('0') {
            return Err(invalid());
        }
        if !id.bytes().all(|byte| byte.is_ascii_digit())
            || id.parse::<u64>().map_err(|_| invalid())? > i64::MAX as u64
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Report<'a> {
    Ready {
        token: &'a str,
        cols: u16,
        rows: u16,
    },
    Input {
        token: &'a str,
        #[serde(rename = "acceptedBytes")]
        accepted_bytes: String,
    },
    State {
        token: &'a str,
        running: bool,
        #[serde(rename = "treeRunning")]
        tree_running: Option<bool>,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        signal: Option<&'static str>,
        #[serde(rename = "outputComplete")]
        output_complete: bool,
        #[serde(rename = "outputFinalBytes")]
        output_final_bytes: Option<String>,
    },
    Control {
        token: &'a str,
        id: &'a str,
        ok: bool,
    },
}

pub fn geometry(cols: u16, rows: u16) -> io::Result<()> {
    if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
        return Err(invalid());
    }
    Ok(())
}

fn token(value: &str) -> io::Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid-host-terminal")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> Launch {
        Launch {
            token: "a".repeat(64),
            executable: "/bin/sh".into(),
            arguments: vec!["-c".into(), "printf ok".into()],
            windows_verbatim_arguments: false,
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn launch_preserves_arguments_and_rejects_ambiguous_or_unbounded_input() {
        assert_eq!(launch().validate().unwrap()[2].to_bytes(), b"printf ok");
        let mut selected = launch();
        selected.arguments.push("\0".into());
        assert!(selected.validate().is_err());
        selected = launch();
        selected.cols = 1;
        assert!(selected.validate().is_err());
        selected = launch();
        selected.token.push('\n');
        assert!(selected.validate().is_err());
        selected = launch();
        selected.windows_verbatim_arguments = true;
        assert!(selected.validate().is_err());
    }

    #[test]
    fn controls_require_the_same_private_token_and_exact_bounded_ids() {
        let expected = "a".repeat(64);
        for id in ["0", "01", "1\n", "9223372036854775808"] {
            assert!(
                Control::Stop {
                    token: expected.clone(),
                    id: id.into()
                }
                .validate(&expected)
                .is_err()
            );
        }
        assert!(
            Control::Stop {
                token: expected.clone(),
                id: "1".into()
            }
            .validate(&expected)
            .is_ok()
        );
        assert!(
            serde_json::from_str::<Control>(
                r#"{"operation":"stop","token":"a","id":"1","id":"2"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Control>(
                r#"{"operation":"stop","token":"a","id":"1","unexpected":true}"#
            )
            .is_err()
        );
    }
}
