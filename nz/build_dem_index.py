"""One-off: index the LINZ 1 m DEM STAC sheets (id -> bbox) so a bbox can be mapped to COG URLs."""
import json, os, urllib.request  # run from the repo root; writes data/dem_1m_index.json
os.makedirs('data', exist_ok=True)
from concurrent.futures import ThreadPoolExecutor
B = 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/'
col = json.load(urllib.request.urlopen(B + 'collection.json'))
ids = [l['href'][2:-5] for l in col['links'] if l.get('rel') == 'item']
def get(i):
    return i, json.load(urllib.request.urlopen(f'{B}{i}.json'))['bbox']
with ThreadPoolExecutor(16) as ex:
    idx = dict(ex.map(get, ids))
json.dump(idx, open('data/dem_1m_index.json', 'w'))
print(len(idx), 'sheets indexed')
