import json, math, sys, numpy as np, rasterio
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LightSource
from shapely.geometry import shape
from shapely.ops import transform
def area(g, lat):
    kx=111.32*math.cos(math.radians(lat)); return transform(lambda x,y,z=None:(x*kx,y*110.54), g).area
runs = {'tararua_cal':(-40.87,175.45,(1.575,4.05,10.8),(1.5,3.0,6.0)),'holdsworth_cal':(-40.95,175.65,(1.575,4.05,10.8),(1.5,3.0,6.0))}
fig, axes = plt.subplots(1, len(runs), figsize=(8*len(runs), 8))
for ax,(name,(lat,lng,cal,raw)) in zip(axes, runs.items()):
    gj=json.load(open(f'results/{name}.geojson')); feats=gj['features']
    with rasterio.open(f'results/{name}.dem.tif') as s:
        d=s.read(1).astype(float); d[d<-1000]=np.nan; b=s.bounds
    ls=LightSource(azdeg=315, altdeg=45); hs=ls.hillshade(np.nan_to_num(d), vert_exag=2, dx=30, dy=30)
    with rasterio.open(f'results/{name}.cost_surface.tif') as s: fr=s.read(1)
    ax.imshow(hs, cmap='gray', extent=(b.left,b.right,b.bottom,b.top))
    ax.imshow(np.where(fr<=1.0,1,np.nan), cmap='autumn', extent=(b.left,b.right,b.bottom,b.top), alpha=.9)
    ax.imshow(np.where(fr>=50,1,np.nan), cmap='winter', extent=(b.left,b.right,b.bottom,b.top), alpha=.8)
    rows=[]
    for f,c in zip(feats,('lime','yellow','red')):
        g=shape(f['geometry']); rows.append(round(area(g,lat),1))
        polys=[g] if g.geom_type=='Polygon' else list(g.geoms)
        for p in polys:
            x,y=p.exterior.xy; ax.plot(x,y,color=c,lw=2)
    ax.plot([lng],[lat],'w*',ms=16,mec='k')
    circ=[round(math.pi*r**2,1) for r in raw]
    ax.set_title(f'{name}: ring areas km2 {rows} (Koester circles {circ})', fontsize=10)
    print(name, 'ring km2', rows, 'circle', circ, 'ratio', [round(a/c,2) for a,c in zip(rows,circ)])
plt.tight_layout(); plt.savefig('results/overview.png', dpi=90)
