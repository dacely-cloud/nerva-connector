// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** One private Gio connection pins portal ownership, requests explicit consent and retains only the selected monitor. */
export class HostDesktopWaylandPortal {
    /** The portal and its response signals share the same unique D-Bus owner until explicit cleanup. */
    public static readonly source: string = String.raw`
class Portal:
    destination = 'org.freedesktop.portal.Desktop'
    path = '/org/freedesktop/portal/desktop'
    remote = 'org.freedesktop.portal.RemoteDesktop'
    screen = 'org.freedesktop.portal.ScreenCast'
    def __init__(self, cancelled, frames):
        self.cancelled,self.frames = cancelled,frames
        self.bus = self.owner = self.session = None
        self.active_request = None
        self.closed = self.denied = self.cleanup_uncertain = False
        self.width = self.height = self.logical_width = self.logical_height = 0
        self.node = self.descriptor = None
        self.keys,self.buttons = set(),set()
        self.subscriptions = []
        self.cancellable = Gio.Cancellable()
        self.cast,self.devices = {},{}
    def call(self, interface, method, parameters, path=None, timeout=2000, cancel=True):
        if cancel:
            drain()
            if self.cancelled.is_set(): raise Failure('canceled')
            if self.closed: raise Failure('unavailable')
        return self.bus.call_sync(self.owner,path or self.path,interface,method,parameters,None,Gio.DBusCallFlags.NONE,timeout,self.cancellable if cancel else None)
    def connect(self):
        if self.bus is not None: return
        address = os.environ.get('DBUS_SESSION_BUS_ADDRESS','')
        if not address: raise Failure('unavailable')
        bus = Gio.DBusConnection.new_for_address_sync(address,Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,self.cancellable)
        bus.set_exit_on_close(False)
        owner,invalidated = [None],[False]
        subscription = None
        def owner_changed(connection, sender, path, interface, signal, parameters):
            name,before,after = parameters.unpack()
            if owner[0] is not None and before==owner[0] and after!=owner[0]:
                invalidated[0] = True
                if self.bus is bus: self.closed = True
        def current_owner():
            return bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetNameOwner',GLib.Variant('(s)',(self.destination,)),GLib.VariantType.new('(s)'),Gio.DBusCallFlags.NONE,2000,self.cancellable).unpack()[0]
        def properties(interface, target):
            return unbox(bus.call_sync(target,self.path,'org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',(interface,)),None,Gio.DBusCallFlags.NONE,2000,self.cancellable))[0]
        try:
            subscription = bus.signal_subscribe('org.freedesktop.DBus','org.freedesktop.DBus','NameOwnerChanged','/org/freedesktop/DBus',self.destination,Gio.DBusSignalFlags.NONE,owner_changed)
            properties(self.remote,self.destination)
            owner[0] = current_owner()
            cast = properties(self.screen,owner[0])
            devices = properties(self.remote,owner[0])
            current = current_owner()
            drain()
            if self.cancelled.is_set(): raise Failure('canceled')
            if invalidated[0] or current!=owner[0]: raise Failure('unavailable')
            self.owner,self.cast,self.devices = owner[0],cast,devices
            self.subscriptions.append(subscription)
            self.bus = bus
        except BaseException:
            try:
                if subscription is not None: bus.signal_unsubscribe(subscription)
            finally:
                try:
                    if not bus.is_closed(): bus.close_sync(None)
                except BaseException:
                    self.bus,self.owner = bus,owner[0]
                    self.closed = self.cleanup_uncertain = True
                    raise
            raise
    def info(self):
        drain()
        if self.denied: return self.information(False,'consent-denied',[])
        if self.closed: return self.information(False,'session-closed',[])
        missing = list(self.frames.missing)
        if not os.environ.get('DBUS_SESSION_BUS_ADDRESS'): missing.append('Interactive user DBUS_SESSION_BUS_ADDRESS')
        if missing: return self.information(False,'missing-tools',missing)
        try:
            self.connect()
            if type(self.cast.get('version')) is not int or self.cast['version']<3:
                return self.information(False,'unsupported',['xdg-desktop-portal ScreenCast v3 or newer with monitor metadata'])
            if type(self.devices.get('AvailableDeviceTypes')) is not int or self.devices['AvailableDeviceTypes']&3 != 3 or type(self.cast.get('AvailableSourceTypes')) is not int or self.cast['AvailableSourceTypes']&1 != 1:
                return self.information(False,'unsupported',['Portal RemoteDesktop keyboard/pointer and monitor ScreenCast support'])
            if self.session is not None:
                try: self.frames.validate()
                except Failure:
                    self.closed = True
                    self.close()
                    return self.information(False,'session-closed',[])
            return self.information(self.session is not None,None if self.session is not None else 'consent-required',[])
        except (GLib.Error,Failure):
            return self.information(False,'unavailable',['Interactive user session bus and xdg-desktop-portal RemoteDesktop/ScreenCast backend'])
    def information(self, ready, reason, prerequisites):
        return dict(kind='info',ready=ready,reason=reason,prerequisites=prerequisites,width=self.width if ready else 0,height=self.height if ready else 0)
    def request(self, interface, method, signature, arguments, timeout=5):
        token = 'nexa_'+secrets.token_hex(16)
        sender = self.bus.get_unique_name()[1:].replace('.','_')
        expected = self.path+'/request/'+sender+'/'+token
        options = dict(arguments[-1])
        options['handle_token'] = GLib.Variant('s',token)
        parameters = GLib.Variant(signature,tuple(arguments[:-1])+(options,))
        result = []
        loop = GLib.MainLoop()
        def response(connection, sender, path, interface, signal, values):
            result.append(unbox(values))
            loop.quit()
        subscription = self.bus.signal_subscribe(self.owner,'org.freedesktop.portal.Request','Response',expected,None,Gio.DBusSignalFlags.NONE,response)
        deadline = time.monotonic()+timeout
        def check():
            if self.cancelled.is_set() or self.closed or time.monotonic()>=deadline:
                loop.quit()
                return False
            return True
        timer = GLib.timeout_add(50,check)
        self.active_request = expected
        try:
            returned = self.call(interface,method,parameters).unpack()[0]
            if returned != expected: raise Failure('unavailable')
            if not result: loop.run()
            if not result:
                self.call('org.freedesktop.portal.Request','Close',None,expected,cancel=False)
                raise Failure('canceled' if self.cancelled.is_set() else 'failed')
            status,values = result[0]
            if type(status) is not int or status not in (0,1,2): raise Failure('failed')
            if status != 0:
                self.denied = status == 1
                raise Failure('denied' if status == 1 else 'failed')
            return values
        finally:
            self.active_request = None
            self.bus.signal_unsubscribe(subscription)
            if GLib.MainContext.default().find_source_by_id(timer) is not None: GLib.source_remove(timer)
    def open(self):
        observed = self.info()
        if observed['ready']: return observed
        if observed['reason'] != 'consent-required': raise Failure('denied' if self.denied else 'unavailable')
        try:
            token = 'nexa_'+secrets.token_hex(16)
            expected = self.path+'/session/'+self.bus.get_unique_name()[1:].replace('.','_')+'/'+token
            result = self.request(self.remote,'CreateSession','(a{sv})',({'session_handle_token':GLib.Variant('s',token)},))
            self.session = result.get('session_handle')
            if self.session != expected: raise Failure('unavailable')
            self.subscriptions.append(self.bus.signal_subscribe(self.owner,'org.freedesktop.portal.Session','Closed',self.session,None,Gio.DBusSignalFlags.NONE,self.session_closed))
            self.request(self.remote,'SelectDevices','(oa{sv})',(self.session,{'types':GLib.Variant('u',3)}))
            cursors = self.cast.get('AvailableCursorModes',1)
            self.request(self.screen,'SelectSources','(oa{sv})',(self.session,{'types':GLib.Variant('u',1),'multiple':GLib.Variant('b',False),'cursor_mode':GLib.Variant('u',2 if type(cursors) is int and cursors&2 else 1)}))
            result = self.request(self.remote,'Start','(osa{sv})',(self.session,'',{}),50)
            streams = result.get('streams')
            if result.get('devices') != 3 or type(streams) not in (list,tuple) or len(streams)!=1: raise Failure('unavailable')
            stream = streams[0]
            if type(stream) not in (list,tuple) or len(stream)!=2: raise Failure('unavailable')
            self.node,properties = stream
            size = properties.get('size')
            serial = properties.get('pipewire-serial')
            if type(self.node) is not int or not 0<self.node<4294967296 or properties.get('source_type')!=1 or serial is not None and (type(serial) is not int or not 0<serial<18446744073709551616) or type(size) not in (list,tuple) or len(size)!=2 or any(type(value) is not int or not 0<value<=65535 for value in size): raise Failure('unavailable')
            self.logical_width,self.logical_height = size
            result,descriptors = self.bus.call_with_unix_fd_list_sync(self.owner,self.path,self.screen,'OpenPipeWireRemote',GLib.Variant('(oa{sv})',(self.session,{})),GLib.VariantType.new('(h)'),Gio.DBusCallFlags.NONE,2000,None,self.cancellable)
            index = result.unpack()[0]
            if type(index) is not int or descriptors is None or not 0<=index<descriptors.get_length(): raise Failure('failed')
            self.descriptor = descriptors.get(index)
            self.frames.open(self.descriptor,self.node,serial)
            _,self.width,self.height = self.capture(1,1)
            return self.information(True,None,[])
        except BaseException:
            self.closed = not self.denied
            self.close()
            raise
    def session_closed(self, connection, sender, path, interface, signal, parameters): self.closed = True
    def capture(self, maximum_width, maximum_height):
        drain()
        if self.session is None or self.closed: raise Failure('unavailable')
        try: result = self.frames.capture(maximum_width,maximum_height)
        except Failure:
            self.closed = True
            self.close()
            raise
        if self.width and (result[1]!=self.width or result[2]!=self.height):
            self.closed = True
            self.close()
            raise Failure('unavailable')
        drain()
        if self.closed: raise Failure('unavailable')
        return result
    def input(self, method, signature, values):
        if self.session is None or self.closed: raise Failure('unavailable')
        try: self.frames.validate()
        except Failure:
            self.closed = True
            self.close()
            raise
        self.call(self.remote,method,GLib.Variant(signature,(self.session,{})+tuple(values)))
    def button(self, name, state):
        buttons = {'left':272,'right':273,'middle':274}
        if name not in buttons: raise Failure('invalid')
        if state: self.buttons.add(name)
        self.input('NotifyPointerButton','(oa{sv}iu)',(buttons[name],state))
        if not state: self.buttons.discard(name)
    def symbol(self, key):
        named = {'Control':0xffe3,'Alt':0xffe9,'Shift':0xffe1,'Meta':0xffeb,'Enter':0xff0d,'Tab':0xff09,'Escape':0xff1b,'Backspace':0xff08,'Delete':0xffff,'Insert':0xff63,'Home':0xff50,'End':0xff57,'PageUp':0xff55,'PageDown':0xff56,'Up':0xff52,'Down':0xff54,'Left':0xff51,'Right':0xff53,'Space':32}
        if key in named: return named[key]
        if len(key)==1 and key.isascii() and key.isalnum(): return ord(key)
        if key.startswith('F') and key[1:].isdigit() and 1<=int(key[1:])<=12: return 0xffbd+int(key[1:])
        raise Failure('invalid')
    def keysym(self, symbol, state):
        if state: self.keys.add(symbol)
        self.input('NotifyKeyboardKeysym','(oa{sv}iu)',(symbol,state))
        if not state: self.keys.discard(symbol)
    def close_session(self):
        deadline = time.monotonic()+1.5
        if self.bus is not None and self.session is not None:
            for method,signature,value in [('NotifyKeyboardKeysym','(oa{sv}iu)',symbol) for symbol in tuple(self.keys)]+[('NotifyPointerButton','(oa{sv}iu)',dict(left=272,right=273,middle=274)[name]) for name in tuple(self.buttons)]:
                remaining = int((deadline-time.monotonic())*1000)
                if remaining<=0:
                    self.cleanup_uncertain = True
                    break
                try: self.call(self.remote,method,GLib.Variant(signature,(self.session,{},value,0)),timeout=remaining,cancel=False)
                except GLib.Error: self.cleanup_uncertain = True
            try: self.call('org.freedesktop.portal.Session','Close',None,self.session,timeout=500,cancel=False)
            except GLib.Error: pass
        self.frames.close()
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None
        self.session = None
        self.keys.clear()
        self.buttons.clear()
    def close(self):
        self.close_session()
        if self.bus is not None:
            for subscription in self.subscriptions: self.bus.signal_unsubscribe(subscription)
            self.subscriptions.clear()
            self.bus.close_sync(None)
            self.bus = None
`;
}
