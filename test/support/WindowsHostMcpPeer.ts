// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** The fixed peer exercises ordinary MCP framing without Roblox, external services or a desktop. */
export class WindowsHostMcpPeer {
    /** ASCII batch text lets cmd expand native Unicode environment and directory values itself. */
    public static readonly batch: string =
        '@echo off\r\n"%NERVA_WINDOWS_MCP_NODE%" "%~dp0peer.mjs"\r\n';
    /** One explicit EOF marker proves stderr closure independently from the stdout protocol stream. */
    public static readonly completed: string = 'fixture-stdio-complete\n';
    /** No caller text is interpreted as source; bounded newline JSON arrives only through stdin. */
    public static readonly source: string = String.raw`
import { createInterface } from 'node:readline';
let initialized=false,notified=false,calls=0,frames=0;
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    if (++frames>8||Buffer.byteLength(line)>4096) throw Error('fixture input bound');
    const request=JSON.parse(line);
    if (!request||typeof request!=='object'||Array.isArray(request)||request.jsonrpc!=='2.0') throw Error('fixture JSON-RPC');
    if (request.method==='notifications/initialized'&&!('id' in request)) {
        if (!initialized||notified) throw Error('fixture notification');
        notified=true;continue;
    }
    if (!Number.isSafeInteger(request.id)||request.id<1||request.id>8) throw Error('fixture identity');
    let result;
    if (request.method==='initialize') {
        if (initialized||request.params?.protocolVersion!=='2025-11-25') throw Error('fixture initialize');
        initialized=true;
        result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'windows-cmd-stdio-fixture',version:'1'},_meta:{pid:String(process.pid),directory:process.cwd(),localAppData:process.env.LOCALAPPDATA}};
    } else if (request.method==='tools/list') {
        if (!notified) throw Error('fixture list before initialization');
        result={tools:[{name:'inspect',description:'Echo inert fixture input.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};
    } else if (request.method==='tools/call') {
        if (!notified||++calls>2||request.params?.name!=='inspect'||typeof request.params.arguments?.text!=='string'||Buffer.byteLength(request.params.arguments.text)>1024) throw Error('fixture tool input');
        result={content:[{type:'text',text:JSON.stringify({pid:String(process.pid),call:calls,text:request.params.arguments.text})}],isError:false};
    } else throw Error('fixture method');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
if (!notified||calls!==2) throw Error('fixture incomplete lifecycle');
process.stderr.write('fixture-stdio-complete\n');
`;
}
