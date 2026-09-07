#!/usr/bin/env python3
"""
geotiff_to_flood_overlay.py
----------------------------
Converts a flood-depth GeoTIFF (Float32, NoData=NaN, values in metres)
into a coloured RGBA overlay in your choice of output format.

Depth classes and colours (RGBA):
  > 4 m          – deep navy         #090991  (9, 9, 145)
  3–4 m          – dark blue         #123db8  (18, 61, 184)
  2–3 m          – medium blue       #1f83e0  (31, 131, 224)
  1–2 m          – light blue        #68c6e8  (104, 198, 232)
  0–1 m          – pale cyan-blue    #b6edf0  (182, 237, 240)
  NoData / 0 m   – fully transparent (alpha = 0)

Output formats
--------------
  .tif / .tiff   RGBA GeoTIFF reprojected to EPSG:4326 (WGS 84).
                 This is the correct format for importing into CloudTAK.
                 The file retains full georeferencing so it can also be
                 loaded directly in QGIS, ArcGIS, etc.

  .png           RGBA PNG at original projection (NZTM2000).
                 An accompanying world file (.pgw) is written alongside.

Usage
-----
    # CloudTAK import (GeoTIFF, EPSG:4326)
    python3 geotiff_to_flood_overlay.py input.tif [output.tif]

    # Plain PNG overlay
    python3 geotiff_to_flood_overlay.py input.tif output.png

If the output path is omitted the result is written next to the input
file with _overlay.tif appended.

Requirements
------------
    apt install python3-gdal python3-numpy
    # PIL/Pillow only needed for PNG output:
    pip install pillow  (or: apt install python3-pil)
"""

import sys
import os
import numpy as np
from osgeo import gdal, osr

# ---------------------------------------------------------------------------
# Colour map  –  (min_depth_exclusive, max_depth_inclusive, RGBA uint8)
# Depths are in metres.  NoData (NaN) and depth == 0 → fully transparent.
# ---------------------------------------------------------------------------
DEPTH_CLASSES = [
    (0.0,  1.0,  (182, 237, 240, 200)),   # 0–1 m   – pale cyan-blue
    (1.0,  2.0,  (104, 198, 232, 210)),   # 1–2 m   – light blue
    (2.0,  3.0,  ( 31, 131, 224, 220)),   # 2–3 m   – medium blue
    (3.0,  4.0,  ( 18,  61, 184, 230)),   # 3–4 m   – dark blue
    (4.0, None,  (  9,   9, 145, 240)),   # > 4 m   – deep navy
]


def depth_to_rgba(depth_array: np.ndarray) -> np.ndarray:
    """Map a 2-D float32 depth array to a (H, W, 4) uint8 RGBA array."""
    rgba = np.zeros((*depth_array.shape, 4), dtype=np.uint8)
    for lo, hi, colour in DEPTH_CLASSES:
        mask = (depth_array > lo) if hi is None else ((depth_array > lo) & (depth_array <= hi))
        rgba[mask] = colour
    # Pixels that remain all-zero (NaN / no-flood / depth == 0) stay transparent.
    return rgba


# ---------------------------------------------------------------------------
# GeoTIFF output  (preferred for CloudTAK)
# ---------------------------------------------------------------------------

def write_geotiff(rgba: np.ndarray, output_path: str,
                  src_ds: gdal.Dataset, reproject_to_epsg4326: bool = True) -> None:
    """
    Write an RGBA GeoTIFF.

    If reproject_to_epsg4326 is True (default) the raster is warped from
    its source CRS (NZTM2000 / EPSG:2193) to WGS 84 geographic
    (EPSG:4326) so that CloudTAK and other web tools can consume it
    without additional reprojection.
    """
    h, w = rgba.shape[:2]

    # --- Write an intermediate in-memory RGBA GeoTIFF at source projection ---
    mem_driver = gdal.GetDriverByName("MEM")
    mem_ds = mem_driver.Create("", w, h, 4, gdal.GDT_Byte)
    mem_ds.SetGeoTransform(src_ds.GetGeoTransform())
    mem_ds.SetProjection(src_ds.GetProjection())

    color_interp = [
        gdal.GCI_RedBand,
        gdal.GCI_GreenBand,
        gdal.GCI_BlueBand,
        gdal.GCI_AlphaBand,
    ]
    for i in range(4):
        b = mem_ds.GetRasterBand(i + 1)
        b.WriteArray(rgba[:, :, i])
        b.SetColorInterpretation(color_interp[i])
        if i == 3:                       # alpha band: 0 = transparent
            b.SetNoDataValue(0)
    mem_ds.FlushCache()

    if reproject_to_epsg4326:
        print("  Reprojecting to EPSG:4326 (WGS 84) …")
        dst_srs = osr.SpatialReference()
        dst_srs.ImportFromEPSG(4326)

        warp_opts = gdal.WarpOptions(
            format="GTiff",
            dstSRS=dst_srs.ExportToWkt(),
            resampleAlg=gdal.GRA_NearestNeighbour,   # nearest keeps exact class colours
            creationOptions=[
                "COMPRESS=DEFLATE",
                "PREDICTOR=2",
                "TILED=YES",
                "BLOCKXSIZE=256",
                "BLOCKYSIZE=256",
                "ALPHA=YES",
            ],
            multithread=True,
        )
        out_ds = gdal.Warp(output_path, mem_ds, options=warp_opts)
    else:
        gtiff_driver = gdal.GetDriverByName("GTiff")
        out_ds = gtiff_driver.CreateCopy(
            output_path, mem_ds,
            options=[
                "COMPRESS=DEFLATE",
                "PREDICTOR=2",
                "TILED=YES",
                "BLOCKXSIZE=256",
                "BLOCKYSIZE=256",
            ],
        )

    if out_ds is None:
        raise RuntimeError(f"GDAL failed to write '{output_path}'")

    out_ds.FlushCache()
    out_ds = None
    mem_ds = None


# ---------------------------------------------------------------------------
# PNG output  (plain georeferenced PNG + world file)
# ---------------------------------------------------------------------------

def write_png(rgba: np.ndarray, output_path: str, geotransform) -> None:
    try:
        from PIL import Image
    except ImportError:
        raise ImportError("Pillow is required for PNG output: pip install pillow")

    print("  Writing PNG …")
    img = Image.fromarray(rgba, mode="RGBA")
    img.save(output_path, format="PNG", optimize=False)
    print(f"  PNG saved  : {output_path}")

    # World file (.pgw)
    gt = geotransform
    cx = gt[0] + gt[1] * 0.5 + gt[2] * 0.5   # pixel centre X
    cy = gt[3] + gt[4] * 0.5 + gt[5] * 0.5   # pixel centre Y
    pgw_path = os.path.splitext(output_path)[0] + ".pgw"
    with open(pgw_path, "w") as fh:
        fh.write(f"{gt[1]:.10f}\n{gt[4]:.10f}\n{gt[2]:.10f}\n"
                 f"{gt[5]:.10f}\n{cx:.3f}\n{cy:.3f}\n")
    print(f"  World file : {pgw_path}")


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------

def convert(input_tif: str, output_path: str) -> None:
    ext = os.path.splitext(output_path)[1].lower()
    if ext not in (".tif", ".tiff", ".png"):
        raise ValueError(f"Unsupported output extension '{ext}'. Use .tif or .png")

    print(f"Input  : {input_tif}")
    print(f"Output : {output_path}  (format: {'GeoTIFF' if ext in ('.tif', '.tiff') else 'PNG'})")

    # --- Open source raster ---
    ds = gdal.Open(input_tif, gdal.GA_ReadOnly)
    if ds is None:
        raise RuntimeError(f"GDAL could not open '{input_tif}'")

    band = ds.GetRasterBand(1)
    nodata = band.GetNoDataValue()
    print(f"  Size       : {ds.RasterXSize} x {ds.RasterYSize} pixels")
    print(f"  NoData val : {nodata}")

    # Read depth values
    depth = band.ReadAsArray().astype(np.float32)

    # Replace NaN / explicit nodata → 0 (transparent)
    depth = np.where(np.isnan(depth), 0.0, depth)
    if nodata is not None and not np.isnan(float(nodata)):
        depth = np.where(depth == float(nodata), 0.0, depth)
    depth = np.where(depth < 0, 0.0, depth)

    stats = band.GetStatistics(False, True)
    if stats:
        print(f"  Depth range: {stats[0]:.3f} – {stats[1]:.3f} m")

    # --- Classify ---
    print("  Classifying depth values …")
    rgba = depth_to_rgba(depth)

    flooded = int(np.sum(rgba[:, :, 3] > 0))
    total   = depth.size
    print(f"  Flooded pixels : {flooded:,} / {total:,}  ({100.0 * flooded / total:.2f} %)")

    # --- Write output ---
    if ext in (".tif", ".tiff"):
        write_geotiff(rgba, output_path, ds, reproject_to_epsg4326=True)
        print(f"  GeoTIFF saved : {output_path}")
    else:
        write_png(rgba, output_path, ds.GetGeoTransform())

    ds = None
    print("Done.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    input_tif = sys.argv[1]
    if not os.path.isfile(input_tif):
        print(f"ERROR: file not found: {input_tif}", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        base = os.path.splitext(input_tif)[0]
        output_path = base + "_overlay.tif"

    convert(input_tif, output_path)


if __name__ == "__main__":
    main()
