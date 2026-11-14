from PIL import Image
from campusmap_v3 import paint_track
triangles=[{'pts':[[10,10],[20,10],[10,20]],'rgb':[200,40,30]}]
a=Image.new('RGB',(64,64),(10,20,30));before=a.tobytes()
box=paint_track(a,0,0,1,triangles)
assert all(abs(a-b)<=2 for a,b in zip(a.getpixel((12,12)),(200,40,30)))
assert a.getpixel((40,40))==(10,20,30)
assert a.crop((0,0,8,64)).tobytes()==Image.frombytes('RGB',(64,64),before).crop((0,0,8,64)).tobytes()
assert paint_track(a,1000,1000,1,triangles) is None
print('PASS: local geometry paint, unchanged distant pixels, no overlap no-op')
