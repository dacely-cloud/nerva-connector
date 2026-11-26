// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';

/** Only owned fixture paths and explicit local answers enter the terminal process. */
export interface ConnectorPermissionTerminalInput {
    readonly directory: string;
    readonly workspace: string;
    readonly mode: ConnectorFileMode;
    readonly allow: boolean;
    readonly entryFile?: string;
    readonly interruptAfterApproval?: boolean;
}

/** The reviewed terminal child produces only bounded UTF-8 diagnostic output. */
interface PermissionTerminalOutput {
    readonly stdout: string;
    readonly stderr: string;
}

/** Drives the real installed CLI in a real TTY; it owns and joins exactly its child and PTY descriptors. */
export class ConnectorPermissionTerminal {
    /** The signed runtime/application/helper remain in the one original fixture installation. */
    public static async run(input: ConnectorPermissionTerminalInput): Promise<string> {
        const script: string = String.raw`
import os,pty,select,subprocess,sys,time,termios,fcntl,struct,re
master,slave=pty.openpty()
before=termios.tcgetattr(slave)
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,160,0,0))
child=subprocess.Popen([sys.argv[1],sys.argv[2],'connector','permissions','--installation',sys.argv[3]],stdin=slave,stdout=slave,stderr=slave,env={'PATH':os.environ['PATH'],'HOME':sys.argv[3],'NODE_OPTIONS':''},close_fds=True)
data=b''
def wait(text):
 global data
 end=time.monotonic()+15
 while time.monotonic()<end:
  current=data.rsplit(b'\x1b[2J',1)[-1]
  ready=b'\x1b[?25h' in current if text==b'Choose a folder to share' else '›'.encode() in current if text in [b'What can Nexa do in this folder?',b'Allow access to this folder?'] else True
  if ready and (text in current if text!=b'controlled-post-approval-preparation' else text in data):return
  if child.poll() is not None:raise RuntimeError('Permission CLI exited before its requested prompt')
  if select.select([master],[],[],.05)[0]:
   data+=os.read(master,65536)
   if len(data)>2097152:raise RuntimeError('Unbounded permission output')
 raise RuntimeError('Permission prompt deadline expired')
try:
 wait(b'Choose a folder to share')
 assert re.search(rb'\x1b\[[0-9;]*m',data)
 assert b'255;106;42' in data
 os.write(master,b'\x15'+sys.argv[4].encode('utf-8')+b'\r')
 wait(b'What can Nexa do in this folder?')
 os.write(master,(b'2' if sys.argv[5]=='read-write' else b'1')+b'\r')
 wait(b'Allow access to this folder?')
 assert sys.argv[4].encode('utf-8') in data
 assert b'Not allowed' in data
 os.write(master,b'\x1b[B\r' if sys.argv[6]=='allow' else b'\r')
 if sys.argv[7]=='interrupt':
  wait(b'controlled-post-approval-preparation')
  os.write(master,b'\x03')
  assert child.wait(timeout=3)==1
 else:
  end=time.monotonic()+20
  while child.poll() is None and time.monotonic()<end:
   if select.select([master],[],[],.05)[0]:
    data+=os.read(master,65536)
    if len(data)>2097152:raise RuntimeError('Unbounded permission completion output')
  assert child.wait(timeout=.1)==0
 while select.select([master],[],[],.01)[0]:
  try:chunk=os.read(master,65536)
  except OSError:break
  if not chunk:break
  data+=chunk
  if len(data)>2097152:raise RuntimeError('Unbounded permission output')
 if sys.argv[7]=='interrupt':
  assert b'it may already be on' in data
  assert b'Try again with the same' in data
 assert b'\x1b[?1049l' in data
 assert termios.tcgetattr(slave)==before
 print('real-terminal-local-approval-verified')
finally:
 if child.poll() is None:
  child.terminate()
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
 os.close(master);os.close(slave)
`;
        const result: PermissionTerminalOutput = await promisify(execFile)(
            '/usr/bin/python3',
            [
                '-I',
                '-B',
                '-c',
                script,
                join(input.directory, 'node'),
                input.entryFile ?? join(input.directory, 'nerva-connector.mjs'),
                input.directory,
                input.workspace,
                input.mode,
                input.allow ? 'allow' : 'cancel',
                input.interruptAfterApproval === true ? 'interrupt' : 'normal',
            ],
            {
                env: { PATH: process.env['PATH'] },
                timeout: 45000,
                maxBuffer: 16384,
                encoding: 'utf8',
            },
        );
        return result.stdout;
    }
}
