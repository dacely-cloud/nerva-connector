# SPDX-FileCopyrightText: 2026 Nerva contributors
# SPDX-License-Identifier: LicenseRef-Proprietary

import sys,json,types,threading
class Failure(Exception): pass
def drain(): pass
exec(compile(sys.stdin.read(),'Frames','exec'))
class Structure:
    def __init__(self,width,height): self.width,self.height=width,height
    def get_name(self): return 'video/x-raw'
    def get_value(self,key): return self.width if key=='width' else self.height
class Caps:
    def __init__(self,width,height): self.structure=Structure(width,height)
    def is_any(self): return False
    def is_empty(self): return False
    def get_size(self): return 1
    def get_structure(self,index): return self.structure
class Device:
    def __init__(self,node,serial,width=1920,height=1080): self.node,self.serial,self.caps=node,serial,Caps(width,height)
    def find_property(self,name): return name in ('id','serial')
    def get_property(self,name): return self.node if name=='id' else self.serial
    def get_caps(self): return self.caps
class Provider:
    def __init__(self): self.devices=[Device(77,123456789012345)];self.stopped=0;self.fd=None
    def set_property(self,key,value): assert key=='fd';self.fd=value
    def start(self): return True
    def get_devices(self): return self.devices
    def stop(self): self.stopped+=1
provider=Provider()
class Factory:
    @staticmethod
    def get_by_name(name): assert name=='pipewiredeviceprovider';return provider
frames=Frames.__new__(Frames)
frames.cancelled=threading.Event();frames.Gst=types.SimpleNamespace(DeviceProviderFactory=Factory)
frames.provider=frames.fd=frames.node=frames.serial=frames.geometry=None
frames.open(42,77,None)
assert frames.serial==123456789012345 and frames.geometry==(1920,1080) and provider.fd==42
frames.validate()
for device in [Device(77,999),Device(78,123456789012345),Device(77,123456789012345,2560,1440)]:
    provider.devices=[device]
    try: frames.validate();raise AssertionError('rebound selected stream')
    except Failure: pass
for width,height in [(65535,65535),(4097,4097),(0,720),([1,65535],720)]:
    provider.devices=[Device(77,123456789012345,width,height)]
    try: frames.open(42,77,None);raise AssertionError('accepted unbounded source caps')
    except Failure: pass
provider.devices=[Device(77,123456789012345)]
try: frames.open(42,77,999);raise AssertionError('portal serial mismatch')
except Failure: pass
class Pointer:
    def __init__(self,address,api=None): self.address,self.api=address,api
    def __hash__(self): return self.address
info_target=ctypes.c_uint64(0)
info=Pointer(ctypes.addressof(info_target),42)
frames.GstVideo=types.SimpleNamespace(video_crop_meta_get_info=lambda:info)
regions=[]
def crop(x,y,width,height,info_address=info.address):
    region=CropMeta(0,info_address,x,y,width,height);regions.append(region)
    return Pointer(ctypes.addressof(region))
cases=[(False,None,True),(True,None,False),(False,crop(0,0,0,0),True),(False,crop(0,0,1920,1080),True),(True,crop(0,0,1920,1080),False),(False,crop(8,0,1912,1080),False),(False,crop(0,0,1280,720),False),(False,crop(0,0,1920,1080,ctypes.addressof(regions[0])),False),(False,types.SimpleNamespace(),False)]
for transformed,meta,accepted in cases:
    sample=types.SimpleNamespace(get_buffer=lambda meta=meta:types.SimpleNamespace(get_meta=lambda api:meta if api==42 else None))
    try:
        frames.validate_sample(sample,transformed)
        assert accepted
    except Failure: assert not accepted
frames.close();assert provider.stopped==1
print(json.dumps(dict(ok=True,serialExact=True,boundedBeforeCapture=True)))
