import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Call synchronously while the scheduler is idle. No request callback may
// interleave state/transcript mutations during this single-process snapshot.
export function createLocalBackup({ dataFile, scheduler, store }) {
  if (scheduler.running.size) throw Object.assign(new Error('実行完了後にバックアップしてください'), { status: 409 });
  store.save();
  const parent = path.join(path.dirname(dataFile), 'backups');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const id = `local-${Date.now()}-${randomUUID()}`;
  const staging = path.join(parent, `${id}.partial`);
  const destination = path.join(parent, id);
  fs.mkdirSync(staging, { mode: 0o700 });
  const files = [];
  const copy = (source, name) => {
    if (!fs.lstatSync(source).isFile()) throw new Error('Backup refuses non-regular files');
    const target = path.join(staging, name);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    files.push(name);
  };
  try {
    copy(dataFile, 'state.json');
    const transcripts = `${dataFile}.local-conversations`;
    if (fs.existsSync(transcripts)) {
      if (!fs.lstatSync(transcripts).isDirectory()) throw new Error('Invalid transcript directory');
      fs.mkdirSync(path.join(staging, 'conversations'), { mode: 0o700 });
      for (const name of fs.readdirSync(transcripts)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Unexpected transcript entry; backup not finalized');
        copy(path.join(transcripts, name), path.join('conversations', name));
      }
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ version: 1, backend: 'local', files,
      restore: 'While the server is stopped, restore state.json to the configured dataFile and conversations to dataFile.local-conversations.' }, null, 2), { mode: 0o600 });
    fs.renameSync(staging, destination);
    return { path: destination, files: files.length };
  } catch (error) {
    // Keep partial evidence, but never expose it as a completed backup.
    throw Object.assign(new Error(`Backup failed; incomplete snapshot retained: ${staging}. ${error.message}`), { status: 500 });
  }
}
