// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Private physical expectations are consumed before the launcher transition and never sealed into the guest configuration.

use super::configuration::{Configuration, invalid, validate};
use crate::cgroup_identity::CgroupIdentity;
use crate::workspace_identity::WorkspaceIdentity;
use serde::Deserialize;
use std::fs::File;
use std::io;
use std::os::fd::FromRawFd;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchConfiguration {
    configuration: Configuration,
    workspace_identity: WorkspaceIdentity,
    cgroup_identity: CgroupIdentity,
}

/// Return only the existing inner contract after both exact inherited capabilities match.
pub fn decode(bytes: &[u8]) -> io::Result<Configuration> {
    let launch = parse(bytes)?;
    let workspace = duplicate(6)?;
    let group = duplicate(7)?;
    checked(launch, &workspace, &group)
}

fn parse(bytes: &[u8]) -> io::Result<LaunchConfiguration> {
    if bytes.len() > super::limits::LAUNCH_BYTES {
        return Err(invalid());
    }
    let launch: LaunchConfiguration = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    validate(&launch.configuration)?;
    if serde_json::to_vec(&launch.configuration)
        .map_err(|_| invalid())?
        .len()
        > super::limits::CONFIGURATION_BYTES
    {
        return Err(invalid());
    }
    Ok(launch)
}

fn checked(
    launch: LaunchConfiguration,
    workspace: &File,
    group: &File,
) -> io::Result<Configuration> {
    if WorkspaceIdentity::capture(workspace).map_err(|_| invalid())? != launch.workspace_identity
        || CgroupIdentity::capture(group).map_err(|_| invalid())? != launch.cgroup_identity
    {
        return Err(invalid());
    }
    Ok(launch.configuration)
}

fn duplicate(source: i32) -> io::Result<File> {
    // SAFETY: The fixed inherited workspace/group is borrowed; copies are above every executable/bootstrap FD.
    let descriptor = unsafe { libc::fcntl(source, libc::F_DUPFD_CLOEXEC, 32) };
    if descriptor < 0 {
        return Err(invalid());
    }
    // SAFETY: Successful duplication returned a fresh descriptor owned solely by this File.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cgroup_fixture::CgroupFixture;
    use serde_json::{Value, json};
    use std::path::PathBuf;

    fn inner() -> Value {
        json!({
            "admissionExpiresAtMs": "9223372036854775807",
            "apparmorProfile": format!("nerva-connector-exec-{}-{}", "a".repeat(32), "b".repeat(64)),
            "program": "/usr/bin/probe",
            "arguments": [],
            "input": {
                "kind": "fixed"
            },
            "allowedExecutables": ["/usr/bin/probe"],
            "executableDescriptors": [
                {
                    "path": "/usr/bin/probe",
                    "descriptor": 8
                }
            ],
            "workspaceAccess": "read-write",
            "parentNamespaces": {},
            "maximumCpuSeconds": 1,
            "maximumAddressBytes": "67108864",
            "maximumFileBytes": "0"
        })
    }

    fn envelope() -> Value {
        json!({
            "configuration": inner(),
            "workspaceIdentity": {
                "filesystemUuid": "00000000000000000000000000000001",
                "device": "1",
                "inode": "1",
                "handleType": 1,
                "handle": "0000000000000001"
            },
            "cgroupIdentity": {
                "bootId": "00000000-0000-0000-0000-000000000001",
                "device": "1",
                "filesystemId": "0000000000000001",
                "handleType": 254,
                "handle": "0000000000000001"
            }
        })
    }

    fn parsed(value: &Value) -> io::Result<LaunchConfiguration> {
        parse(&serde_json::to_vec(value).unwrap())
    }

    #[test]
    fn launch_has_no_flat_missing_unknown_or_oversized_inner_fallback() {
        assert!(parsed(&envelope()).is_ok());
        assert!(parsed(&inner()).is_err());
        for expiry in [
            json!("0"),
            json!("01"),
            json!("-1"),
            json!("9223372036854775808"),
            json!(1),
            json!(null),
        ] {
            let mut value = envelope();
            value["configuration"]["admissionExpiresAtMs"] = expiry;
            assert!(parsed(&value).is_err());
        }
        let mut missing_expiry = envelope();
        missing_expiry["configuration"]
            .as_object_mut()
            .unwrap()
            .remove("admissionExpiresAtMs");
        assert!(parsed(&missing_expiry).is_err());
        for key in ["workspaceIdentity", "cgroupIdentity", "configuration"] {
            let mut value = envelope();
            value.as_object_mut().unwrap().remove(key);
            assert!(parsed(&value).is_err());
        }
        let mut value = envelope();
        value["extra"] = json!(false);
        assert!(parsed(&value).is_err());
        let mut value = envelope();
        value["configuration"]["workspaceIdentity"] = value["workspaceIdentity"].clone();
        assert!(parsed(&value).is_err());
        assert!(parse(&vec![b' '; super::super::limits::LAUNCH_BYTES + 1]).is_err());
    }

    fn boundary_configuration() -> Value {
        let mut value = inner();
        // All sixteen native table entries remain below the independent per-path ceiling.
        // Quotes and backslashes are valid local path bytes and expand during serialization.
        let mut lower = 2;
        let mut upper = (4096 - 7) / 2;
        while lower <= upper {
            let units = (lower + upper) / 2;
            let paths: Vec<String> = (0..16)
                .map(|index| format!("/opt/{}{}", "\\\"".repeat(units), index))
                .collect();
            let mut candidate = inner();
            candidate["program"] = json!(paths[0]);
            candidate["allowedExecutables"] = json!(paths);
            candidate["executableDescriptors"] = json!(
                paths
                    .iter()
                    .enumerate()
                    .map(|(index, path)| json!({
                        "path": path,
                        "descriptor": 8 + index
                    }))
                    .collect::<Vec<_>>()
            );
            candidate["arguments"] = json!(["\u{1}".repeat(4096), "\u{2}".repeat(3904)]);
            if serde_json::to_vec(&candidate).unwrap().len()
                > super::super::limits::CONFIGURATION_BYTES
            {
                upper = units - 1;
            } else {
                lower = units + 1;
                value = candidate;
            }
        }
        let size = serde_json::to_vec(&value).unwrap().len();
        let padding = super::super::limits::CONFIGURATION_BYTES - size - 3;
        assert!(padding <= 192);
        value["arguments"]
            .as_array_mut()
            .unwrap()
            .push(json!("a".repeat(padding)));
        assert_eq!(
            serde_json::to_vec(&value).unwrap().len(),
            super::super::limits::CONFIGURATION_BYTES
        );
        value
    }

    #[test]
    fn exact_normalized_inner_and_raw_outer_boundaries_are_independent() {
        let mut value = envelope();
        value["configuration"] = boundary_configuration();
        assert!(parsed(&value).is_ok());
        let configuration = serde_json::to_vec(&value["configuration"]).unwrap();
        let mut sealed = tempfile::tempfile().unwrap();
        use std::io::{Seek, Write};
        sealed.write_all(&configuration).unwrap();
        sealed.rewind().unwrap();
        assert!(super::super::configuration::read(sealed).is_ok());
        let mut bytes = serde_json::to_vec(&value).unwrap();
        assert!(bytes.len() - super::super::limits::CONFIGURATION_BYTES <= 1024);
        bytes.resize(super::super::limits::LAUNCH_BYTES, b' ');
        assert!(parse(&bytes).is_ok());
        bytes.push(b' ');
        assert!(parse(&bytes).is_err());
        value["configuration"]["arguments"][2] = json!(format!(
            "{}a",
            value["configuration"]["arguments"][2].as_str().unwrap()
        ));
        assert_eq!(
            serde_json::to_vec(&value["configuration"]).unwrap().len(),
            super::super::limits::CONFIGURATION_BYTES + 1
        );
        assert!(serde_json::to_vec(&value).unwrap().len() < super::super::limits::LAUNCH_BYTES);
        assert!(parsed(&value).is_err());
        let mut sealed = tempfile::tempfile().unwrap();
        sealed
            .write_all(&serde_json::to_vec(&value["configuration"]).unwrap())
            .unwrap();
        sealed.rewind().unwrap();
        assert!(super::super::configuration::read(sealed).is_err());
    }

    #[test]
    #[ignore = "requires owned ext4 fixture and writable cgroup2 hierarchy"]
    fn exact_opened_workspace_and_group_are_required_before_launcher_transition() {
        let parent = PathBuf::from(std::env::var_os("NERVA_ROOT_IDENTITY_TEST_PARENT").unwrap());
        let owned = tempfile::tempdir_in(parent).unwrap();
        let path = owned.path().join("workspace");
        std::fs::create_dir(&path).unwrap();
        let root = File::open(&path).unwrap();
        let fixture = CgroupFixture::new();
        let group = fixture.open();
        let mut value = envelope();
        value["workspaceIdentity"] = serde_json::to_value(
            WorkspaceIdentity::capture(&root)
                .unwrap_or_else(|_| panic!("Qualified workspace capture failed")),
        )
        .unwrap();
        value["cgroupIdentity"] = serde_json::to_value(
            CgroupIdentity::capture(&group)
                .unwrap_or_else(|_| panic!("Qualified cgroup capture failed")),
        )
        .unwrap();
        let inner = checked(parsed(&value).unwrap(), &root, &group).unwrap();
        // Only the inner configuration is serializable into the sealed guest channel.
        let sealed = serde_json::to_value(inner).unwrap();
        assert_eq!(sealed, value["configuration"]);
        assert!(sealed.get("workspaceIdentity").is_none());
        assert!(sealed.get("cgroupIdentity").is_none());
        for key in ["bootId", "device", "filesystemId", "handle"] {
            let mut changed = value.clone();
            changed["cgroupIdentity"][key] = match key {
                "bootId" => json!("00000000-0000-0000-0000-000000000001"),
                "device" => json!("18446744073709551615"),
                _ => json!("ffffffffffffffff"),
            };
            assert_ne!(changed["cgroupIdentity"][key], value["cgroupIdentity"][key]);
            assert!(checked(parsed(&changed).unwrap(), &root, &group).is_err());
        }
        std::fs::rename(&path, owned.path().join("renamed")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(checked(parsed(&value).unwrap(), &root, &group).is_ok());
        assert!(checked(parsed(&value).unwrap(), &File::open(&path).unwrap(), &group).is_err());
        let other_group = CgroupFixture::new();
        assert!(checked(parsed(&value).unwrap(), &root, &other_group.open()).is_err());
        std::fs::remove_dir(owned.path().join("renamed")).unwrap();
        assert!(checked(parsed(&value).unwrap(), &root, &group).is_err());
    }
}
