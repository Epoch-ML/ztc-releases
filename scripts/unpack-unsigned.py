"""Unpack an unsigned app on the isolated signer, preserving executable modes."""
import pathlib
import shutil
import stat
import sys
import tarfile


def unpack(archive_path: pathlib.Path, output: pathlib.Path) -> None:
    metadata = archive_path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 256 * 1024 * 1024:
        raise ValueError("unsigned archive must be a bounded regular file")
    if output.exists() or output.is_symlink():
        raise ValueError("unsigned output must not already exist")
    with tarfile.open(archive_path, "r:gz") as archive:
        members = []
        names: set[str] = set()
        total = 0
        for member in archive:
            name = member.name.rstrip("/")
            parts = name.split("/")
            if (
                not parts or parts[0] != "ztc.app"
                or any(part in ("", ".", "..") for part in parts)
                or "\\" in name or any(ord(char) < 32 or ord(char) == 127 for char in name)
                or name in names or not (member.isfile() or member.isdir())
            ):
                raise ValueError("unsafe unsigned archive entry")
            names.add(name)
            total += member.size
            if len(names) > 32768 or member.size > 512 * 1024 * 1024 or total > 1024 * 1024 * 1024:
                raise ValueError("unsigned archive exceeds its inventory or size limit")
            members.append(member)
        if not members:
            raise ValueError("unsigned archive is empty")
        output.mkdir(parents=True)
        try:
            for member in members:
                target = output.joinpath(*member.name.rstrip("/").split("/"))
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    source = archive.extractfile(member)
                    if source is None:
                        raise ValueError("unsigned archive member is unreadable")
                    with source, target.open("xb") as destination:
                        shutil.copyfileobj(source, destination, length=1024 * 1024)
                    target.chmod(member.mode & 0o777)
        except BaseException:
            shutil.rmtree(output)
            raise


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: unpack-unsigned.py ARCHIVE OUTPUT")
    unpack(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
