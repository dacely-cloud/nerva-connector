# SPDX-FileCopyrightText: 2026 Nerva contributors
# SPDX-License-Identifier: LicenseRef-Proprietary

import json,os,sys,threading,time
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
    raise AssertionError('unbounded fixture signal work')

class Failure(Exception):
    def __init__(self,code): self.code=code

class Frames:
    missing=[]
    def close(self): pass

payload=json.loads(sys.stdin.read())
exec(compile(payload['source'],'Portal','exec'))
NAME='org.freedesktop.portal.Desktop'
PATH='/org/freedesktop/portal/desktop'
XML='''<node><interface name="org.freedesktop.DBus.Properties"><method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method></interface></node>'''

class Service:
    def __init__(self):
        self.bus=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
        self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',(NAME,0)),None,0,2000,None)
        self.fail=False
        self.replace=False
        self.remote_reads=0
        self.senders=[]
        self.context=GLib.MainContext.new()
        self.ready=threading.Event()
        self.loop=GLib.MainLoop.new(self.context,False)
        self.thread=threading.Thread(target=self.run)
        self.thread.start()
        assert self.ready.wait(2)
    def run(self):
        self.context.push_thread_default()
        self.bus.register_object(PATH,Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0],self.call,None,None)
        self.ready.set()
        self.loop.run()
        self.context.pop_thread_default()
    def call(self,connection,sender,path,interface,method,parameters,invocation):
        assert method=='GetAll'
        self.senders.append(sender)
        requested=parameters.unpack()[0]
        if self.fail:
            self.fail=False
            invocation.return_dbus_error('org.freedesktop.portal.Error.Failed','transient fixture discovery failure')
            return
        properties={'version':GLib.Variant('u',3)}
        if requested.endswith('RemoteDesktop'):
            self.remote_reads+=1
            properties['AvailableDeviceTypes']=GLib.Variant('u',3)
            if self.replace and self.remote_reads==2:
                self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName',GLib.Variant('(s)',(NAME,)),None,0,2000,None)
                if self.replace=='bounce':
                    second.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName',GLib.Variant('(s)',(NAME,)),None,0,2000,None)
                    self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',(NAME,0)),None,0,2000,None)
        elif requested.endswith('ScreenCast'):
            properties['AvailableSourceTypes']=GLib.Variant('u',1)
            properties['AvailableCursorModes']=GLib.Variant('u',1)
        else: raise AssertionError('unexpected discovery interface')
        invocation.return_value(GLib.Variant('(a{sv})',(properties,)))
    def has_owner(self,name):
        return self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',(name,)),GLib.VariantType.new('(b)'),0,2000,None).unpack()[0]
    def shutdown(self):
        self.loop.quit()
        self.thread.join(2)
        assert not self.thread.is_alive()
        self.bus.close_sync(None)

first=Service()
second=None
portal=Portal(threading.Event(),Frames())
try:
    if payload['mode']=='retry':
        first.fail=True
        assert portal.info()['reason']=='unavailable'
        failed_sender=first.senders[-1]
        assert portal.bus is None and not first.has_owner(failed_sender)
        assert portal.info()['reason']=='consent-required'
        sender=portal.bus.get_unique_name()
        assert sender!=failed_sender
        count=len(first.senders)
        assert portal.info()['reason']=='consent-required' and len(first.senders)==count
        assert portal.session is None
    elif payload['mode'] in ('replacement','bounce'):
        second=Service()
        first.replace=payload['mode']
        assert portal.info()['reason']=='unavailable'
        assert portal.bus is None and portal.session is None
        assert first.has_owner(first.bus.get_unique_name())
        assert portal.info()['reason']=='consent-required'
        expected=second if payload['mode']=='replacement' else first
        assert portal.owner==expected.bus.get_unique_name()
        assert portal.session is None and len(expected.senders)>0
    else: raise AssertionError('unknown fixture mode')
    portal.close()
    print(json.dumps({'ok':True,'mode':payload['mode'],'noConsent':True}))
finally:
    try: portal.close()
    finally:
        try:
            if second is not None: second.shutdown()
        finally: first.shutdown()
