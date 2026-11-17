//! Explicit resumable uploads use bounded chunks and publish once; uncertain publication is never replayed.
use super::{Failure, Output, WriteMode, decimal, filesystem, request_id, upload_slot as slot};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use std::fs::File;
use std::os::unix::fs::FileExt;

const MAXIMUM_CHUNK: usize = 65536;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub request_id: String,
    pub path: String,
    pub upload_id: String,
    pub binding_sha256: String,
    pub mode: WriteMode,
    pub size_bytes: String,
    pub sha256: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chunk {
    pub request_id: String,
    pub path: String,
    pub upload_id: String,
    pub binding_sha256: String,
    pub mode: WriteMode,
    pub size_bytes: String,
    pub sha256: String,
    pub offset: String,
    pub data_base64: String,
}

fn capture(target: &Target) -> Result<(slot::Descriptor, u64), Failure> {
    request_id(&target.request_id)?;
    for hash in [&target.upload_id, &target.binding_sha256, &target.sha256] {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(Failure::Invalid);
        }
    }
    let size = decimal(&target.size_bytes)?;
    if size > i64::MAX as u64 {
        return Err(Failure::Invalid);
    }
    filesystem::relative(&target.path)?;
    Ok((
        slot::Descriptor {
            path: target.path.clone(),
            upload_id: target.upload_id.clone(),
            binding_sha256: target.binding_sha256.clone(),
            mode: target.mode,
            size_bytes: target.size_bytes.clone(),
            sha256: target.sha256.clone(),
        },
        size,
    ))
}

pub fn begin(root: &File, stage: &File, target: Target) -> Result<Output, Failure> {
    let (descriptor, size) = capture(&target)?;
    filesystem::parent(root, &target.path)?;
    let stage = slot::lock(stage)?;
    if slot::descriptor(&stage, slot::PARTIAL)?.is_some() {
        return Err(Failure::Changed);
    }
    let received = if let Some(existing) = slot::descriptor(&stage, slot::META)? {
        if existing != descriptor {
            return Err(Failure::Changed);
        }
        slot::data(&stage, size)?.1
    } else {
        if slot::file(&stage, slot::DATA, false)?.is_some() {
            return Err(Failure::Indeterminate);
        }
        let bytes = serde_json::to_vec(&descriptor).map_err(|_| Failure::Unavailable)?;
        if bytes.len() > 8192 {
            return Err(Failure::Invalid);
        }
        let partial = slot::create(&stage, slot::PARTIAL)?;
        partial
            .write_all_at(&bytes, 0)
            .map_err(|_| Failure::Indeterminate)?;
        partial.sync_all().map_err(|_| Failure::Indeterminate)?;
        slot::rename(
            &stage,
            slot::PARTIAL,
            &stage,
            c"upload-metadata",
            WriteMode::Create,
        )?;
        stage.sync_all().map_err(|_| Failure::Indeterminate)?;
        let data = slot::create(&stage, slot::DATA).map_err(|_| Failure::Indeterminate)?;
        data.sync_all().map_err(|_| Failure::Indeterminate)?;
        stage.sync_all().map_err(|_| Failure::Indeterminate)?;
        0
    };
    Ok(Output::UploadBegin {
        request_id: target.request_id,
        upload_id: target.upload_id,
        received_bytes: received.to_string(),
    })
}

pub fn chunk(_root: &File, stage: &File, chunk: Chunk) -> Result<Output, Failure> {
    let target = Target {
        request_id: chunk.request_id,
        path: chunk.path,
        upload_id: chunk.upload_id,
        binding_sha256: chunk.binding_sha256,
        mode: chunk.mode,
        size_bytes: chunk.size_bytes,
        sha256: chunk.sha256,
    };
    let (descriptor, maximum) = capture(&target)?;
    let offset = decimal(&chunk.offset)?;
    if chunk.data_base64.is_empty() || chunk.data_base64.len() > MAXIMUM_CHUNK.div_ceil(3) * 4 {
        return Err(Failure::Invalid);
    }
    let bytes = STANDARD
        .decode(&chunk.data_base64)
        .map_err(|_| Failure::Invalid)?;
    if bytes.is_empty()
        || bytes.len() > MAXIMUM_CHUNK
        || offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > maximum)
    {
        return Err(Failure::Invalid);
    }
    let stage = slot::lock(stage)?;
    slot::match_descriptor(&stage, &descriptor)?;
    let (data, size) = slot::data(&stage, maximum)?;
    if size != offset {
        return Err(Failure::Changed);
    }
    data.write_all_at(&bytes, offset)
        .map_err(|_| Failure::Indeterminate)?;
    data.sync_all().map_err(|_| Failure::Indeterminate)?;
    let received = offset + bytes.len() as u64;
    if filesystem::raw(&data)
        .map_err(|_| Failure::Indeterminate)?
        .st_size as u64
        != received
    {
        return Err(Failure::Indeterminate);
    }
    Ok(Output::UploadChunk {
        request_id: target.request_id,
        upload_id: target.upload_id,
        received_bytes: received.to_string(),
    })
}

pub fn status(_root: &File, stage: &File, target: Target) -> Result<Output, Failure> {
    let (descriptor, maximum) = capture(&target)?;
    let stage = slot::lock(stage)?;
    slot::match_descriptor(&stage, &descriptor)?;
    let (data, size) = slot::data(&stage, maximum)?;
    Ok(Output::UploadStatus {
        request_id: target.request_id,
        upload_id: target.upload_id,
        received_bytes: size.to_string(),
        sha256: slot::hash(&data, size)?,
    })
}

pub fn commit(root: &File, stage: &File, target: Target) -> Result<Output, Failure> {
    let (descriptor, size) = capture(&target)?;
    let stage = slot::lock(stage)?;
    slot::match_descriptor(&stage, &descriptor)?;
    let (data, received) = slot::data(&stage, size)?;
    if received != size || slot::hash(&data, received)? != target.sha256 {
        return Err(Failure::Changed);
    }
    let before = filesystem::raw(&data)?;
    let (parent, name) = filesystem::parent(root, &target.path)?;
    let replaced = if target.mode == WriteMode::Replace {
        Some(filesystem::regular(root, &target.path)?)
    } else {
        None
    };
    data.sync_all().map_err(|_| Failure::Unavailable)?;
    slot::rename(&stage, slot::DATA, &parent, &name, target.mode)?;
    parent.sync_all().map_err(|_| Failure::Indeterminate)?;
    stage.sync_all().map_err(|_| Failure::Indeterminate)?;
    let published =
        filesystem::target(root, &target.path, false).map_err(|_| Failure::Indeterminate)?;
    let after = filesystem::raw(&published).map_err(|_| Failure::Indeterminate)?;
    if after.st_dev != before.st_dev
        || after.st_ino != before.st_ino
        || after.st_size as u64 != size
        || after.st_mode & 0o7777 != 0o600
    {
        return Err(Failure::Indeterminate);
    }
    if let Some((file, _)) = replaced
        && filesystem::identity(&file)
            .map_err(|_| Failure::Indeterminate)?
            .st_nlink
            != 0
    {
        return Err(Failure::Indeterminate);
    }
    slot::unlink(&stage, slot::META)?;
    stage.sync_all().map_err(|_| Failure::Indeterminate)?;
    Ok(Output::UploadCommit {
        request_id: target.request_id,
        upload_id: target.upload_id,
        bytes_written: size.to_string(),
        sha256: target.sha256,
        metadata: filesystem::metadata(&after).map_err(|_| Failure::Indeterminate)?,
    })
}

pub fn abort(_root: &File, stage: &File, target: Target) -> Result<Output, Failure> {
    let (descriptor, maximum) = capture(&target)?;
    let stage = slot::lock(stage)?;
    let metadata = slot::descriptor(&stage, slot::META)?;
    let partial = slot::descriptor(&stage, slot::PARTIAL)?;
    if metadata.as_ref().is_some_and(|value| value != &descriptor)
        || partial.as_ref().is_some_and(|value| value != &descriptor)
    {
        return Err(Failure::Changed);
    }
    let data = slot::file(&stage, slot::DATA, true)?;
    if data.is_some() && metadata.is_none() {
        return Err(Failure::Indeterminate);
    }
    if let Some(file) = &data
        && filesystem::raw(file)?.st_size as u64 > maximum
    {
        return Err(Failure::Denied);
    }
    let removed = metadata.is_some() || partial.is_some() || data.is_some();
    if data.is_some() {
        slot::unlink(&stage, slot::DATA)?;
        stage.sync_all().map_err(|_| Failure::Indeterminate)?;
    }
    if metadata.is_some() {
        slot::unlink(&stage, slot::META)?;
    }
    if partial.is_some() {
        slot::unlink(&stage, slot::PARTIAL)?;
    }
    if removed {
        stage.sync_all().map_err(|_| Failure::Indeterminate)?;
    }
    Ok(Output::UploadAbort {
        request_id: target.request_id,
        upload_id: target.upload_id,
        removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn target(bytes: &[u8]) -> Target {
        Target {
            request_id: "request".into(),
            path: "destination".into(),
            upload_id: "a".repeat(64),
            binding_sha256: "b".repeat(64),
            mode: WriteMode::Create,
            size_bytes: bytes.len().to_string(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }
    fn send(
        root: &File,
        stage: &File,
        bytes: &[u8],
        offset: usize,
        length: usize,
    ) -> Result<Output, Failure> {
        let target = target(bytes);
        chunk(
            root,
            stage,
            Chunk {
                request_id: target.request_id,
                path: target.path,
                upload_id: target.upload_id,
                binding_sha256: target.binding_sha256,
                mode: target.mode,
                size_bytes: target.size_bytes,
                sha256: target.sha256,
                offset: offset.to_string(),
                data_base64: STANDARD.encode(&bytes[offset..offset + length]),
            },
        )
    }
    #[test]
    fn staging_accepts_lengths_beyond_the_former_file_cap_without_allocating_the_file() {
        let (_directory, root, stage) = setup();
        let mut commitment = target(b"sample");
        commitment.size_bytes = "67108865".to_string();
        assert!(matches!(
            begin(&root, &stage, commitment),
            Ok(Output::UploadBegin { received_bytes, .. }) if received_bytes == "0"
        ));
        let mut commitment = target(b"sample");
        commitment.size_bytes = "67108865".to_string();
        assert!(abort(&root, &stage, commitment).is_ok());
    }

    fn setup() -> (tempfile::TempDir, File, File) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("stage")).unwrap();
        std::fs::set_permissions(
            directory.path().join("stage"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let root = File::open(directory.path()).unwrap();
        let stage = File::open(directory.path().join("stage")).unwrap();
        (directory, root, stage)
    }
    #[test]
    fn explicit_prefix_resume_single_slot_and_atomic_publication() {
        let (directory, root, stage) = setup();
        let bytes = vec![73u8; 196637];
        assert!(begin(&root, &stage, target(&bytes)).is_ok());
        assert!(send(&root, &stage, &bytes, 1, 1).is_err());
        assert!(send(&root, &stage, &bytes, 0, 65536).is_ok());
        assert!(matches!(
            begin(&root, &stage, target(&bytes)),
            Ok(Output::UploadBegin { received_bytes, .. }) if received_bytes == "65536"
        ));
        let expected_hash = format!("{:x}", Sha256::digest(&bytes[..65536]));
        assert!(matches!(
            status(&root, &stage, target(&bytes)),
            Ok(Output::UploadStatus { received_bytes, sha256, .. })
                if received_bytes == "65536" && sha256 == expected_hash
        ));
        assert!(!directory.path().join("destination").exists());
        assert!(commit(&root, &stage, target(&bytes)).is_err());
        let mut foreign = target(&bytes);
        foreign.binding_sha256 = "c".repeat(64);
        assert!(abort(&root, &stage, foreign).is_err());
        for offset in (65536..bytes.len()).step_by(65536) {
            assert!(
                send(
                    &root,
                    &stage,
                    &bytes,
                    offset,
                    (bytes.len() - offset).min(65536)
                )
                .is_ok()
            );
        }
        assert!(commit(&root, &stage, target(&bytes)).is_ok());
        assert_eq!(
            std::fs::read(directory.path().join("destination")).unwrap(),
            bytes
        );
        assert!(
            std::fs::read_dir(directory.path().join("stage"))
                .unwrap()
                .next()
                .is_none()
        );
        assert!(matches!(
            abort(&root, &stage, target(&bytes)),
            Ok(Output::UploadAbort { removed: false, .. })
        ));
    }
    #[test]
    fn captured_slot_cleanup_and_status_do_not_require_a_surviving_destination_parent() {
        let (directory, root, stage) = setup();
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        let mut captured = target(b"content");
        captured.path = "nested/destination".into();
        assert!(begin(&root, &stage, captured).is_ok());
        std::fs::remove_dir(directory.path().join("nested")).unwrap();
        let mut captured = target(b"content");
        captured.path = "nested/destination".into();
        assert!(matches!(
            status(&root, &stage, captured),
            Ok(Output::UploadStatus { received_bytes, .. }) if received_bytes == "0"
        ));
        let mut captured = target(b"content");
        captured.path = "nested/destination".into();
        assert!(matches!(
            abort(&root, &stage, captured),
            Ok(Output::UploadAbort { removed: true, .. })
        ));
        assert!(!directory.path().join("nested").exists());
        assert!(
            std::fs::read_dir(directory.path().join("stage"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn corrupt_private_slot_links_and_metadata_never_trigger_cleanup() {
        let (directory, root, stage) = setup();
        let metadata = directory.path().join("stage").join(slot::META);
        std::fs::write(&metadata, b"corrupt").unwrap();
        std::fs::set_permissions(&metadata, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(abort(&root, &stage, target(b"content")).is_err());
        assert_eq!(std::fs::read(&metadata).unwrap(), b"corrupt");
        std::fs::remove_file(&metadata).unwrap();
        assert!(begin(&root, &stage, target(b"content")).is_ok());
        let data = directory.path().join("stage").join(slot::DATA);
        std::fs::hard_link(&data, directory.path().join("hard")).unwrap();
        assert!(abort(&root, &stage, target(b"content")).is_err());
        assert!(data.exists());
        assert!(metadata.exists());
    }

    #[test]
    fn independent_stage_open_descriptions_serialize_and_never_recreate_uncertain_data() {
        let (directory, root, stage) = setup();
        let bytes = b"content";
        let guard = slot::lock(&stage).unwrap();
        assert!(matches!(slot::lock(&stage), Err(Failure::Changed)));
        drop(guard);
        assert!(begin(&root, &stage, target(bytes)).is_ok());
        std::fs::remove_file(directory.path().join("stage").join(slot::DATA)).unwrap();
        assert!(matches!(
            begin(&root, &stage, target(bytes)),
            Err(Failure::Indeterminate)
        ));
        assert!(matches!(
            status(&root, &stage, target(bytes)),
            Err(Failure::Indeterminate)
        ));
        assert!(matches!(
            abort(&root, &stage, target(bytes)),
            Ok(Output::UploadAbort { removed: true, .. })
        ));
        assert!(begin(&root, &stage, target(bytes)).is_ok());
        assert!(send(&root, &stage, bytes, 0, bytes.len()).is_ok());
        symlink("somewhere", directory.path().join("destination")).unwrap();
        assert!(commit(&root, &stage, target(bytes)).is_err());
        assert!(abort(&root, &stage, target(bytes)).is_ok());
    }
}
