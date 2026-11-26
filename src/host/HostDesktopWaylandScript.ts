// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostDesktopWaylandFrames } from './HostDesktopWaylandFrames.js';
import { HostDesktopWaylandPortal } from './HostDesktopWaylandPortal.js';

/** The immutable helper owns a private portal connection, one consent generation and bounded image pipes. */
export class HostDesktopWaylandScript {
    /** No caller data enters this source; operations and text arrive only through the private input pipe. */
    public static readonly source: string =
        String.raw`
import os,sys,json,time,secrets,threading,base64,signal
try:
    import gi
    gi.require_version('Gio','2.0')
    from gi.repository import Gio,GLib
except (ImportError,ValueError):
    while True:
        line=sys.stdin.buffer.readline(131073)
        if not line or len(line)>131072 or not line.endswith(b'\n'): break
        try:
            request=json.loads(line)
            if request.get('operation')=='close': break
            print(json.dumps(dict(id=request['id'],error=None,result=dict(kind='info',ready=False,reason='missing-tools',prerequisites=['Python 3 PyGObject with Gio 2.0 and GStreamer 1.0 introspection'],width=0,height=0))),flush=True)
        except (ValueError,KeyError,TypeError): break
    sys.exit(0)
class Failure(Exception):
    def __init__(self, code): self.code=code

def unbox(value):
    if isinstance(value,GLib.Variant): return unbox(value.unpack())
    if isinstance(value,dict): return {key:unbox(item) for key,item in value.items()}
    if isinstance(value,(list,tuple)): return [unbox(item) for item in value]
    return value

def drain():
    context=GLib.MainContext.default()
    for iteration in range(64):
        if not context.pending(): return
        context.iteration(False)
    if context.pending(): raise Failure('failed')

` +
        HostDesktopWaylandFrames.source +
        HostDesktopWaylandPortal.source +
        String.raw`
class Runtime:
    def __init__(self):
        self.cancelled=threading.Event()
        self.frames=Frames(self.cancelled)
        self.portal=Portal(self.cancelled,self.frames)
        self.loop=GLib.MainLoop()
        self.busy=False
        self.closing=False
        self.admission=threading.Lock()
        self.inflight=False
    def emit(self, identifier, result=None, error=None):
        data=json.dumps(dict(id=identifier,result=result,error=error),ensure_ascii=True,separators=(',',':'))
        if len(data)>22460000: raise Failure('failed')
        sys.stdout.write(data+'\n')
        sys.stdout.flush()
    def stop(self):
        self.closing=True
        self.cancelled.set()
        self.portal.cancellable.cancel()
        GLib.idle_add(self.finish_close)
    def finish_close(self):
        if self.busy: return False
        try: self.portal.close()
        finally: self.loop.quit()
        return False
    def number(self, value, maximum):
        if type(value) is not int or value<1 or value>maximum: raise Failure('invalid')
        return value
    def shape(self, value, names):
        if type(value) is not dict or set(value)!=set(names): raise Failure('invalid')
    def execute(self, request):
        operation=request.get('operation')
        base=['id','operation']
        if operation in ('probe','open'):
            self.shape(request,base)
            return self.portal.info() if operation=='probe' else self.portal.open()
        if operation=='capture':
            self.shape(request,base+['maximumWidth','maximumHeight'])
            width=self.number(request['maximumWidth'],4096)
            height=self.number(request['maximumHeight'],4096)
            png,source_width,source_height=self.portal.capture(width,height)
            return dict(kind='capture',png=base64.b64encode(png).decode('ascii'),sourceWidth=source_width,sourceHeight=source_height)
        if self.portal.session is None or self.portal.closed: raise Failure('unavailable')
        if operation=='pointer':
            self.shape(request,base+['pointer'])
            pointer=request['pointer']
            self.shape(pointer,['x','y','action','button'])
            x,y=pointer['x'],pointer['y']
            action,button=pointer['action'],pointer['button']
            if type(x) is not int or type(y) is not int or not 0<=x<self.portal.width or not 0<=y<self.portal.height or action not in ('move','click','down','up') or (button is not None if action=='move' else button not in ('left','middle','right')): raise Failure('invalid')
            self.portal.capture(1,1)
            self.portal.input('NotifyPointerMotionAbsolute','(oa{sv}udd)',(self.portal.node,x*self.portal.logical_width/self.portal.width,y*self.portal.logical_height/self.portal.height))
            if action in ('down','click'): self.portal.button(button,1)
            if action in ('up','click'): self.portal.button(button,0)
        elif operation=='release-button':
            self.shape(request,base+['button'])
            self.portal.button(request['button'],0)
        elif operation=='key':
            self.shape(request,base+['key'])
            key=request['key']
            self.shape(key,['key','action'])
            if type(key['key']) is not str or key['action'] not in ('press','down','up'): raise Failure('invalid')
            symbol=self.portal.symbol(key['key'])
            if key['action'] in ('press','down'): self.portal.keysym(symbol,1)
            if key['action'] in ('press','up'): self.portal.keysym(symbol,0)
        elif operation=='text':
            self.shape(request,base+['text'])
            text=request['text']
            if type(text) is not str or any(0xd800<=ord(character)<=0xdfff or ord(character)<32 and character not in ('\n','\t') or 127<=ord(character)<160 for character in text) or len(text.encode('utf-8'))>16384: raise Failure('invalid')
            for character in text:
                symbol=0xff0d if character=='\n' else 0xff09 if character=='\t' else ord(character) if ord(character)<=255 else 0x01000000|ord(character)
                self.portal.keysym(symbol,1)
                self.portal.keysym(symbol,0)
        else: raise Failure('invalid')
        return dict(kind='sent')
    def command(self, request):
        self.busy=True
        try:
            if self.closing: raise Failure('canceled')
            drain()
            result=self.execute(request)
            self.emit(request['id'],result)
        except Failure as error: self.emit(request['id'],error=error.code)
        except GLib.Error: self.emit(request['id'],error='canceled' if self.cancelled.is_set() else 'failed')
        except (ValueError,TypeError,KeyError,OverflowError,AttributeError): self.emit(request['id'],error='invalid')
        finally:
            self.busy=False
            with self.admission: self.inflight=False
            if self.closing: self.finish_close()
        return False
    def read(self):
        def pairs(entries):
            result={}
            for key,value in entries:
                if key in result: raise ValueError('duplicate')
                result[key]=value
            return result
        try:
            while not self.closing:
                line=sys.stdin.buffer.readline(131073)
                if not line or len(line)>131072 or not line.endswith(b'\n'): break
                request=json.loads(line,object_pairs_hook=pairs)
                if type(request) is not dict: break
                identifier=request.get('id')
                if type(identifier) is not str or not identifier.isascii() or not identifier.isdigit() or str(int(identifier))!=identifier or not 0<=int(identifier)<=9223372036854775807: break
                if request.get('operation')=='close':
                    self.shape(request,['id','operation'])
                    break
                if identifier=='0': break
                with self.admission:
                    if self.inflight: break
                    self.inflight=True
                GLib.idle_add(self.command,request)
        except (ValueError,TypeError,Failure): pass
        finally: self.stop()
    def run(self):
        signal.signal(signal.SIGTERM,lambda *arguments:self.stop())
        signal.signal(signal.SIGINT,lambda *arguments:self.stop())
        reader=threading.Thread(target=self.read,daemon=True)
        reader.start()
        self.loop.run()
        self.portal.close()
        if self.portal.cleanup_uncertain: sys.exit(2)
Runtime().run()
`;
}
