# SPDX-FileCopyrightText: 2026 Nerva contributors
# SPDX-License-Identifier: LicenseRef-Proprietary

import json,os,sys,threading,time,secrets,base64,signal,contextlib,io
import gi
from gi.repository import Gio,GLib

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

class Failure(Exception):
    def __init__(self,code): self.code=code

class Frames:
    missing=[]
    def __init__(self,*arguments): self.closed=False;self.captures=0;self.width=1920;self.height=1080
    def open(self,fd,node,serial):
        assert os.read(fd,1)==b'x' and node==77 and serial is None
    def capture(self,width,height): self.captures+=1;return b'png',self.width,self.height
    def validate(self): pass
    def close(self): self.closed=True

payload=json.loads(sys.stdin.read())
source=payload['portal']
exec(compile(source,'Portal','exec'))
xml='''<node>
<interface name="org.freedesktop.portal.RemoteDesktop">
<property name="version" type="u" access="read"/><property name="AvailableDeviceTypes" type="u" access="read"/>
<method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="NotifyPointerMotionAbsolute"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
<method name="NotifyKeyboardKeysym"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
<method name="NotifyPointerButton"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
</interface>
<interface name="org.freedesktop.portal.ScreenCast">
<property name="version" type="u" access="read"/><property name="AvailableSourceTypes" type="u" access="read"/><property name="AvailableCursorModes" type="u" access="read"/>
<method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="OpenPipeWireRemote"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="h" direction="out"/></method>
</interface></node>'''
request_xml=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.portal.Request"><method name="Close"/></interface></node>')
session_xml=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.portal.Session"><method name="Close"/></interface></node>')
class Service:
    def __init__(self):
        self.bus=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
        self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.freedesktop.portal.Desktop',0)),None,0,2000,None)
        self.loop=GLib.MainLoop()
        self.inputs=[];self.calls=[];self.sessions=0;self.denied=False;self.wait=False;self.multi=False;self.session=None;self.request_closed=0;self.failrelease=False
        self.context=GLib.MainContext.new()
        self.ready=threading.Event()
        self.thread=threading.Thread(target=self.run)
        self.thread.start();self.ready.wait(2)
    def run(self):
        self.context.push_thread_default()
        for interface in Gio.DBusNodeInfo.new_for_xml(xml).interfaces:
            self.bus.register_object('/org/freedesktop/portal/desktop',interface,self.call,self.property,None)
        self.ready.set()
        self.loop=GLib.MainLoop.new(self.context,False);self.loop.run()
        self.context.pop_thread_default()
    def property(self,connection,sender,path,interface,name):
        return GLib.Variant('u',3 if name in ('version','AvailableDeviceTypes') else 1)
    def close(self,connection,sender,path,interface,method,parameters,invocation):
        if interface.endswith('Request'): self.request_closed+=1
        self.calls.append('close');invocation.return_value(None)
    def call(self,connection,sender,path,interface,method,parameters,invocation):
        values=unbox(parameters);self.calls.append(method)
        if method=='OpenPipeWireRemote':
            read,write=os.pipe();os.write(write,b'x');os.close(write)
            descriptors=Gio.UnixFDList.new();index=descriptors.append(read);os.close(read)
            invocation.return_value_with_unix_fd_list(GLib.Variant('(h)',(index,)),descriptors);return
        if method.startswith('Notify'):
            if self.failrelease and method in ('NotifyKeyboardKeysym','NotifyPointerButton') and values[-1]==0:
                invocation.return_dbus_error('org.freedesktop.portal.Error.Failed','fixture release failure');return
            self.last_input=values;self.inputs.append(values);invocation.return_value(None);return
        options=values[-1]
        request='/org/freedesktop/portal/desktop/request/'+sender[1:].replace('.','_')+'/'+options['handle_token']
        self.bus.register_object(request,request_xml.interfaces[0],self.close,None,None)
        result={};status=0
        if method=='CreateSession':
            self.sessions+=1;self.session='/org/freedesktop/portal/desktop/session/'+sender[1:].replace('.','_')+'/'+options['session_handle_token']
            self.bus.register_object(self.session,session_xml.interfaces[0],self.close,None,None)
            result={'session_handle':GLib.Variant('s',self.session)}
        if method=='SelectDevices': assert options['types']==3
        if method=='SelectSources': assert options['types']==1 and options['multiple'] is False
        if method=='Start':
            status=1 if self.denied else 0
            stream=(77,{'source_type':GLib.Variant('u',1),'size':GLib.Variant('(ii)',(1280,720))})
            result={'devices':GLib.Variant('u',3),'streams':GLib.Variant('a(ua{sv})',[stream,stream] if self.multi else [stream])}
        invocation.return_value(GLib.Variant('(o)',(request,)))
        if not (method=='Start' and self.wait): self.bus.emit_signal(sender,request,'org.freedesktop.portal.Request','Response',GLib.Variant('(ua{sv})',(status,result)))
    def shutdown(self): self.loop.quit();self.thread.join(2);self.bus.close_sync(None)

service=Service()
try:
    frames=Frames();cancelled=threading.Event();portal=Portal(cancelled,frames)
    assert portal.info()['reason']=='consent-required' and service.sessions==0
    assert portal.open()['ready'] and portal.width==1920 and portal.logical_width==1280
    portal.open();assert service.sessions==1
    portal.input('NotifyPointerMotionAbsolute','(oa{sv}udd)',(77,960*1280/1920,540*720/1080))
    assert service.last_input[2:]==[77,640.0,360.0]
    portal.keysym(ord('A'),1);portal.button('left',1)
    portal.close();assert frames.closed and service.calls[-1]=='close'
    for mode in ('denied','multi','cancel','closed','replacement'):
        service.denied=mode=='denied';service.multi=mode=='multi';service.wait=mode=='cancel'
        cancelled=threading.Event();portal=Portal(cancelled,Frames())
        if mode in ('denied','multi','cancel'):
            timer=threading.Timer(.1,cancelled.set) if mode=='cancel' else None
            if timer: timer.start()
            try: portal.open();raise AssertionError('unexpected consent')
            except Failure: pass
            if timer: timer.join()
            count=service.sessions
            try: portal.open();raise AssertionError('reconsent')
            except Failure: pass
            assert service.sessions==count
        else:
            portal.open()
            if mode=='closed': service.bus.emit_signal(None,service.session,'org.freedesktop.portal.Session','Closed',GLib.Variant('(a{sv})',({},)))
            else:
                service.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName',GLib.Variant('(s)',('org.freedesktop.portal.Desktop',)),None,0,2000,None)
            deadline=time.monotonic()+1
            while not portal.closed and time.monotonic()<deadline: drain();time.sleep(.01)
            assert portal.info()['reason']=='session-closed'
            before=len(service.calls)
            try: portal.keysym(ord('B'),1);raise AssertionError('input after close')
            except Failure: pass
            assert len(service.calls)==before
        portal.close()
    assert service.request_closed>=1
    service.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.freedesktop.portal.Desktop',0)),None,0,2000,None)
    service.denied=service.multi=service.wait=False
    ModeledFrames=Frames
    exec(compile(payload['runtime'].rsplit('Runtime().run()',1)[0],'Runtime','exec'))
    Frames=ModeledFrames
    runtime=Runtime()
    assert runtime.execute(dict(id='1',operation='open'))['ready']
    runtime.execute(dict(id='2',operation='pointer',pointer=dict(x=960,y=540,action='click',button='left')))
    assert service.inputs[-3][2:]==[77,640.0,360.0] and service.inputs[-2][2:]==[272,1] and service.inputs[-1][2:]==[272,0]
    before=len(service.calls)
    for text in ['bad\x01','bad\ud800','bad\x7f']:
        try: runtime.execute(dict(id='3',operation='text',text=text));raise AssertionError('unsupported text accepted')
        except Failure: pass
    assert len(service.calls)==before
    runtime.execute(dict(id='4',operation='text',text='Aé🚀\n\t'))
    assert any(values[2:]==[0x0101f680,1] for values in service.inputs)
    runtime.frames.width=2560
    try: runtime.execute(dict(id='5',operation='capture',maximumWidth=100,maximumHeight=100));raise AssertionError('geometry changed')
    except Failure: pass
    assert runtime.portal.bus is None and runtime.portal.session is None and runtime.portal.closed
    runtime.portal.close()
    service.wait=True
    runtime=Runtime()
    timer=threading.Timer(.1,runtime.stop);timer.start()
    output=io.StringIO()
    with contextlib.redirect_stdout(output): runtime.command(dict(id='6',operation='open'))
    timer.join()
    assert json.loads(output.getvalue())['error']=='canceled'
    assert runtime.portal.bus is None and runtime.portal.session is None and runtime.frames.closed
    service.wait=False
    runtime=Runtime()
    runtime.execute(dict(id='7',operation='open'))
    runtime.execute(dict(id='8',operation='key',key=dict(key='Shift',action='down')))
    service.failrelease=True
    runtime.portal.close()
    assert runtime.portal.cleanup_uncertain and runtime.portal.bus is None
    print(json.dumps(dict(ok=True,sessions=service.sessions,canceledRequests=service.request_closed)))
finally: service.shutdown()
