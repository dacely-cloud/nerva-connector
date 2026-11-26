// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Fixed GStreamer operations consume only the portal-provided descriptor and one bounded native sample.
 * @remarks Older pipewiresrc builds expose dont-reconnect; PipeWire 1.6 removed it and always
 * connects with PW_STREAM_FLAG_DONT_RECONNECT, so the helper states the same guarantee through
 * the node.dont-reconnect stream property and makes a lost stream an error with on-disconnect.
 * pipewiresrc copies the producer's crop region onto every buffer whether or not downstream
 * supports it, and GNOME attaches one to each monitor frame. PyGObject exposes that region only
 * as a generic Gst.Meta, so the helper reads the stable public GstVideoCropMeta layout at the
 * wrapper's pointer and requires its info pointer to match GstVideoCropMeta before trusting it.
 * Only an empty or full-frame region is accepted; any real crop still fails closed.
 */
export class HostDesktopWaylandFrames {
    /** Reviewed helper source is interpreted directly; no executable, cache or intermediate image is created. */
    public static readonly source: string = String.raw`
import ctypes
class CropMeta(ctypes.Structure):
    _fields_ = [('flags',ctypes.c_uint),('info',ctypes.c_void_p),('x',ctypes.c_uint),('y',ctypes.c_uint),('width',ctypes.c_uint),('height',ctypes.c_uint)]
class Frames:
    factories = ('pipewiresrc','appsink','appsrc','videoconvert','videoscale','capsfilter','pngenc')
    def __init__(self, cancelled):
        self.cancelled = cancelled
        self.Gst = self.GstVideo = None
        self.provider = self.fd = self.serial = self.node = self.geometry = None
        self.missing = []
        try:
            gi.require_version('Gst','1.0')
            gi.require_version('GstVideo','1.0')
            from gi.repository import Gst,GstVideo
            Gst.init(None)
            self.Gst,self.GstVideo = Gst,GstVideo
            if GstVideo.video_crop_meta_get_info().api is None: raise ValueError('Missing video crop metadata API')
            self.missing = ['GStreamer '+name for name in self.factories if Gst.ElementFactory.find(name) is None]
            provider = Gst.DeviceProviderFactory.get_by_name('pipewiredeviceprovider')
            if provider is None or provider.find_property('fd') is None: self.missing.append('GStreamer pipewiredeviceprovider with fd and serial support')
            if not self.missing:
                source = self.element('pipewiresrc')
                for name in ('fd','target-object','min-buffers','max-buffers'):
                    if source.find_property(name) is None: self.missing.append('pipewiresrc property '+name)
                if source.find_property('dont-reconnect') is None and (source.find_property('stream-properties') is None or source.find_property('on-disconnect') is None): self.missing.append('pipewiresrc property dont-reconnect or stream-properties with on-disconnect')
                for factory,names in [('appsrc',('max-bytes','max-buffers','block','format')),('appsink',('max-buffers','drop','sync','wait-on-eos')),('pngenc',('snapshot',))]:
                    element = self.element(factory)
                    for name in names:
                        if element.find_property(name) is None: self.missing.append(factory+' property '+name)
        except (ImportError,ValueError,AttributeError):
            self.missing = ['GStreamer/GstVideo 1.0 Python bindings with PipeWire, Base and Good plugins']
    def open(self, fd, node, expected_serial):
        self.provider = self.Gst.DeviceProviderFactory.get_by_name('pipewiredeviceprovider')
        self.provider.set_property('fd',fd)
        self.fd,self.node = fd,node
        if not self.provider.start(): raise Failure('unavailable')
        devices = self.provider.get_devices()
        matching = [device for device in devices if device.find_property('id') is not None and device.find_property('serial') is not None and device.get_property('id')==node]
        if len(matching)!=1: raise Failure('unavailable')
        serial = matching[0].get_property('serial')
        if type(serial) is not int or not 0<serial<18446744073709551616 or serial==4294967295 or expected_serial is not None and serial!=expected_serial: raise Failure('unavailable')
        self.serial = serial
        self.geometry = self.dimensions(matching[0])
    def dimensions(self, device):
        caps = device.get_caps()
        if caps is None or caps.is_any() or caps.is_empty() or caps.get_size()>64: raise Failure('unavailable')
        dimensions = set()
        for index in range(caps.get_size()):
            structure = caps.get_structure(index)
            if structure.get_name()!='video/x-raw': continue
            width,height = structure.get_value('width'),structure.get_value('height')
            if type(width) is not int or type(height) is not int or not 0<width<=65535 or not 0<height<=65535 or width*height>16777216: raise Failure('unavailable')
            dimensions.add((width,height))
        if len(dimensions)!=1: raise Failure('unavailable')
        return next(iter(dimensions))
    def validate(self):
        drain()
        if self.cancelled.is_set(): raise Failure('canceled')
        if self.provider is None or self.serial is None: raise Failure('unavailable')
        devices = self.provider.get_devices()
        matching = [device for device in devices if device.find_property('id') is not None and device.find_property('serial') is not None and device.get_property('id')==self.node and device.get_property('serial')==self.serial]
        if len(matching)!=1 or self.dimensions(matching[0])!=self.geometry: raise Failure('unavailable')
    def close(self):
        if self.provider is not None:
            self.provider.stop()
            self.provider = None
        self.fd = self.node = self.serial = None
    def element(self, name):
        value = self.Gst.ElementFactory.make(name,None)
        if value is None: raise Failure('unavailable')
        return value
    def pipeline(self, elements):
        value = self.Gst.Pipeline.new(None)
        if value is None: raise Failure('unavailable')
        for element in elements: value.add(element)
        for first,second in zip(elements,elements[1:]):
            if not first.link(second):
                value.set_state(self.Gst.State.NULL)
                raise Failure('unavailable')
        return value
    def pull(self, pipeline, sink, deadline):
        if pipeline.set_state(self.Gst.State.PLAYING) == self.Gst.StateChangeReturn.FAILURE: raise Failure('unavailable')
        while time.monotonic() < deadline and not self.cancelled.is_set():
            drain()
            sample = sink.emit('try-pull-sample',100000000)
            if sample is not None: return sample
            if pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR) is not None: raise Failure('unavailable')
        raise Failure('canceled' if self.cancelled.is_set() else 'failed')
    def sink(self):
        value = self.element('appsink')
        value.set_property('max-buffers',1)
        value.set_property('drop',True)
        value.set_property('sync',False)
        value.set_property('wait-on-eos',False)
        return value
    def crop_region(self, sample):
        info = self.GstVideo.video_crop_meta_get_info()
        meta = sample.get_buffer().get_meta(info.api)
        if meta is None: return None
        mask = (1<<(8*ctypes.sizeof(ctypes.c_void_p)))-1
        try: address,expected = hash(meta)&mask,hash(info)&mask
        except TypeError: raise Failure('unavailable')
        if address==0 or expected==0: raise Failure('unavailable')
        region = CropMeta.from_address(address)
        if region.info!=expected: raise Failure('unavailable')
        return region.x,region.y,region.width,region.height
    def validate_sample(self, sample, transformed):
        if transformed: raise Failure('unavailable')
        region = self.crop_region(sample)
        if region is not None and region!=(0,0,0,0) and region!=(0,0)+tuple(self.geometry): raise Failure('unavailable')
    def capture(self, maximum_width, maximum_height):
        self.validate()
        if self.Gst is None or self.missing: raise Failure('unavailable')
        Gst = self.Gst
        deadline = time.monotonic()+9
        source = self.element('pipewiresrc')
        source.set_property('fd',self.fd)
        source.set_property('target-object',str(self.serial))
        source.set_property('min-buffers',1)
        source.set_property('max-buffers',2)
        if source.find_property('dont-reconnect') is not None:
            source.set_property('dont-reconnect',True)
        else:
            Gst.util_set_object_arg(source,'stream-properties','props,node.dont-reconnect=true')
            Gst.util_set_object_arg(source,'on-disconnect','error')
        raw_filter = self.element('capsfilter')
        raw_filter.set_property('caps',Gst.Caps.from_string('video/x-raw,format=(string){RGBA,BGRA,RGBx,BGRx,RGB,BGR},width='+str(self.geometry[0])+',height='+str(self.geometry[1])))
        raw_sink = self.sink()
        raw_pipeline = self.pipeline([source,raw_filter,raw_sink])
        rejected = [False]
        def bounds(pad, probe):
            event = probe.get_event()
            if event is not None and event.type == Gst.EventType.TAG:
                tags = event.parse_tag()
                found,orientation = tags.get_string('image-orientation')
                if found and orientation!='rotate-0': rejected[0] = True
            if event is not None and event.type == Gst.EventType.CAPS:
                structure = event.parse_caps().get_structure(0)
                width,height = structure.get_value('width'),structure.get_value('height')
                if type(width) is not int or type(height) is not int or width<1 or height<1 or width*height>16777216:
                    rejected[0] = True
                    return Gst.PadProbeReturn.DROP
            return Gst.PadProbeReturn.OK
        source.get_static_pad('src').add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM,bounds)
        encoded_pipeline = None
        sample = encoded = None
        try:
            sample = self.pull(raw_pipeline,raw_sink,deadline)
            self.validate_sample(sample,rejected[0])
            structure = sample.get_caps().get_structure(0)
            width,height = structure.get_value('width'),structure.get_value('height')
            if (width,height)!=self.geometry or rejected[0] or type(width) is not int or type(height) is not int or width<1 or height<1 or width*height>16777216 or sample.get_buffer().get_size()>67108864: raise Failure('unavailable')
            scale = min(1.0,maximum_width/width,maximum_height/height)
            target_width,target_height = max(1,int(width*scale)),max(1,int(height*scale))
            app = self.element('appsrc')
            app.set_property('max-bytes',67108864)
            app.set_property('max-buffers',1)
            app.set_property('block',False)
            app.set_property('format',Gst.Format.TIME)
            converted,scaled = self.element('videoconvert'),self.element('videoscale')
            output_filter = self.element('capsfilter')
            output_filter.set_property('caps',Gst.Caps.from_string('video/x-raw,format=RGBA,width='+str(target_width)+',height='+str(target_height)))
            png = self.element('pngenc')
            png.set_property('snapshot',True)
            sink = self.sink()
            encoded_pipeline = self.pipeline([app,converted,scaled,output_filter,png,sink])
            if encoded_pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE: raise Failure('unavailable')
            if app.emit('push-sample',sample) != Gst.FlowReturn.OK: raise Failure('failed')
            app.emit('end-of-stream')
            encoded = self.pull(encoded_pipeline,sink,deadline)
            buffer = encoded.get_buffer()
            size = buffer.get_size()
            if size<24 or size>16842752: raise Failure('failed')
            return buffer.extract_dup(0,size),width,height
        finally:
            encoded = None
            if encoded_pipeline is not None: encoded_pipeline.set_state(Gst.State.NULL)
            sample = None
            raw_pipeline.set_state(Gst.State.NULL)
`;
}
