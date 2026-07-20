# ATAK Import Plugin — Custom File Routing for Data Packages

## Problem

ATAK's mission package (data package) system extracts files and runs them through a chain of "import sorters" that route files to specific device directories based on file type. However, there are no built-in sorters for:

1. **MOBAC XML map sources** (`<customMapSource>` files) — these need to be placed in `atak/grg/` to appear as toggleable overlays in the GRG Overlay Manager
2. **Terrain JSON manifests** (T3 elevation manifests with `"content": "terrain"`) — these need to be placed in the root `atak/` folder for ATAK to discover them

Without a custom sorter, these files remain in the mission package extraction temp directory and are never picked up by the systems that need them. This means we cannot distribute GRG overlays or terrain configuration via TAK Server data packages to thousands of devices — requiring manual sideloading instead.

## Solution

Build a lightweight ATAK plugin that registers two custom `ImportResolver` classes. Once installed, standard data packages containing these file types will be automatically routed to the correct device directories.

## File Naming Convention

Since the import sorter only has access to the file itself (no manifest metadata), we use filename conventions to disambiguate intent:

- **GRG overlays:** files named `grg_*.xml` containing `<customMapSource>` → routed to `atak/grg/`
- **Terrain manifests:** files named `t3-*.json` containing `"content": "terrain"` → routed to root `atak/`

These conventions are enforced at build time by our packaging scripts. This avoids ambiguity (e.g., a `<customMapSource>` XML could be a basemap or an overlay — the `grg_` prefix makes the intent explicit).

## Architecture

The plugin has no user interface. It registers import resolvers during `onCreate()` and does nothing else.

```
atak-import-plugin/
├── app/
│   ├── build.gradle
│   ├── src/main/
│   │   ├── AndroidManifest.xml
│   │   ├── assets/
│   │   │   └── plugin.xml
│   │   └── java/nz/tak/importer/
│   │       ├── plugin/
│   │       │   ├── ImportPluginLifecycle.java
│   │       │   ├── ImportPluginTool.java
│   │       │   └── PluginNativeLoader.java
│   │       ├── ImportPluginMapComponent.java
│   │       ├── GrgXmlImportResolver.java
│   │       └── TerrainJsonImportResolver.java
│   └── proguard-gradle.txt
├── build.gradle
├── settings.gradle
├── gradle.properties
└── local.properties
```

## Implementation Details

### 1. GrgXmlImportResolver

Matches files named `grg_*.xml` containing a MOBAC `<customMapSource>` element and routes them to `atak/grg/`.

```java
package nz.tak.importer;

import com.atakmap.android.importfiles.sort.ImportInternalSDResolver;
import com.atakmap.coremap.io.IOProviderFactory;
import com.atakmap.coremap.log.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;

/**
 * Routes MOBAC customMapSource XML files prefixed with "grg_" into atak/grg/
 * so they appear in the GRG Overlay Manager as toggleable layers.
 *
 * Naming convention: grg_*.xml
 * Content match: contains "<customMapSource"
 */
public class GrgXmlImportResolver extends ImportInternalSDResolver {

    private static final String TAG = "GrgXmlImportResolver";
    private static final String CONTENT_MATCHER = "<customMapSource";
    private static final String FILENAME_PREFIX = "grg_";

    public GrgXmlImportResolver() {
        // ext=".xml", folderName="grg", validateExt=true, copyFile=false
        super(".xml", "grg", true, false, "GRG Map Source");
    }

    @Override
    public boolean match(File file) {
        if (!super.match(file))
            return false;

        // Filename convention check
        String name = file.getName().toLowerCase();
        if (!name.startsWith(FILENAME_PREFIX))
            return false;

        // Content inspection: verify it's a MOBAC customMapSource
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(IOProviderFactory.getInputStream(file)))) {
            char[] buffer = new char[512];
            int numRead = reader.read(buffer);
            if (numRead < 1) return false;
            String content = new String(buffer, 0, numRead);
            return content.contains(CONTENT_MATCHER);
        } catch (IOException e) {
            Log.w(TAG, "Unable to read file for matching", e);
            return false;
        }
    }
}
```

### 2. TerrainJsonImportResolver

Matches files named `t3-*.json` containing a terrain elevation manifest and routes them to the root `atak/` folder.

```java
package nz.tak.importer;

import com.atakmap.android.importfiles.sort.ImportInternalSDResolver;
import com.atakmap.coremap.io.IOProviderFactory;
import com.atakmap.coremap.log.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;

/**
 * Routes T3 terrain elevation manifest JSON files prefixed with "t3-" into
 * the root atak/ folder where ATAK discovers and registers them as elevation sources.
 *
 * Naming convention: t3-*.json
 * Content match: contains "content" and "terrain"
 */
public class TerrainJsonImportResolver extends ImportInternalSDResolver {

    private static final String TAG = "TerrainJsonImportResolver";
    private static final String CONTENT_KEY = "\"content\"";
    private static final String TERRAIN_VALUE = "\"terrain\"";
    private static final String FILENAME_PREFIX = "t3-";

    public TerrainJsonImportResolver() {
        // ext=".json", folderName="" (root atak folder), validateExt=true, copyFile=false
        super(".json", "", true, false, "Terrain Elevation Manifest");
    }

    @Override
    public boolean match(File file) {
        if (!super.match(file))
            return false;

        // Filename convention check
        String name = file.getName().toLowerCase();
        if (!name.startsWith(FILENAME_PREFIX))
            return false;

        // Content inspection: verify JSON contains "content": "terrain"
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(IOProviderFactory.getInputStream(file)))) {
            char[] buffer = new char[1024];
            int numRead = reader.read(buffer);
            if (numRead < 1) return false;
            String content = new String(buffer, 0, numRead);
            return content.contains(CONTENT_KEY) && content.contains(TERRAIN_VALUE);
        } catch (IOException e) {
            Log.w(TAG, "Unable to read file for matching", e);
            return false;
        }
    }
}
```

### 3. ImportPluginMapComponent

Registers both resolvers when ATAK loads the plugin.

```java
package nz.tak.importer;

import android.content.Context;
import android.content.Intent;

import com.atakmap.android.importexport.ImportExportMapComponent;
import com.atakmap.android.maps.AbstractMapComponent;
import com.atakmap.android.maps.MapView;
import com.atakmap.coremap.log.Log;

public class ImportPluginMapComponent extends AbstractMapComponent {

    private static final String TAG = "ImportPluginMapComponent";
    private GrgXmlImportResolver grgResolver;
    private TerrainJsonImportResolver terrainResolver;

    @Override
    public void onCreate(Context context, Intent intent, MapView view) {
        Log.d(TAG, "Registering custom import resolvers");

        grgResolver = new GrgXmlImportResolver();
        terrainResolver = new TerrainJsonImportResolver();

        ImportExportMapComponent.getInstance().addImporterClass(grgResolver);
        ImportExportMapComponent.getInstance().addImporterClass(terrainResolver);

        Log.d(TAG, "Custom import resolvers registered");
    }

    @Override
    protected void onDestroyImpl(Context context, MapView view) {
        // Resolvers are cleaned up by ATAK when the plugin is unloaded
    }
}
```

### 4. Plugin Registration (plugin.xml)

```xml
<?xml version="1.0" encoding="utf-8"?>
<plugin>
    <extension
        type="transapps.maps.plugin.lifecycle.Lifecycle"
        impl="nz.tak.importer.plugin.ImportPluginLifecycle"
        singleton="true" />
    <extension
        type="transapps.maps.plugin.tool.ToolDescriptor"
        impl="nz.tak.importer.plugin.ImportPluginTool"
        singleton="true" />
</plugin>
```

### 5. Plugin Lifecycle

Standard boilerplate — instantiates `ImportPluginMapComponent` and delegates ATAK lifecycle events. Follow the pattern from the ATAK plugin template: https://github.com/aegorsuch/atak-5.6-plugin-template

## Build Requirements

- ATAK CIV SDK (download from https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/releases)
- Android Studio with Gradle
- `atak-gradle-takdev` plugin (included in SDK zip)
- Signing key for plugin APK

Reference build configuration: https://github.com/aegorsuch/atak-5.6-plugin-template/blob/main/app/build.gradle

## Distribution

1. Build the plugin APK
2. Upload to TAK Server as a data package — ATAK's built-in `ImportAPKSort` handles APK installation
3. Once installed on a device, all subsequent data packages containing `grg_*.xml` or `t3-*.json` files will be automatically routed to the correct folders

## Data Package Creation

Once the plugin is installed on devices, use `create_tak_package.py` to build valid MissionPackageManifest v2 packages:

```bash
# GRG overlays (files must be named grg_*.xml)
python3 flooding/create_tak_package.py \
    --input-dir GRG/grg-output \
    --one-per-file \
    --output-dir GRG/grg-datapackages

# Terrain manifest (file must be named t3-*.json)
python3 flooding/create_tak_package.py \
    terrain-proxy/t3-taknz.json \
    --name "NZ Terrain Elevation Source" \
    --output terrain-proxy/t3-taknz-datapackage.zip
```

## Testing Checklist

- [ ] Plugin installs via data package import on ATAK
- [ ] After plugin install, importing a data package containing `grg_weather_radar.xml` places it in `atak/grg/`
- [ ] The imported XML appears in the GRG Overlay Manager as a toggleable overlay
- [ ] After plugin install, importing a data package containing `t3-taknz.json` places it in the root `atak/` folder
- [ ] ATAK picks up the terrain manifest and registers the elevation source
- [ ] Plugin survives ATAK restart
- [ ] Plugin does not crash if the files already exist (overwrite gracefully)
- [ ] Files not matching the naming convention (e.g., `satellite.xml`) are NOT matched by the plugin

## References

- ATAK Plugin Template (5.6): https://github.com/aegorsuch/atak-5.6-plugin-template
- LearnATAK Plugin Tutorials: https://github.com/Toyon/LearnATAK
- ATAK-CIV Source (import system): https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV
- RIIS ATAK Plugin Guide: https://www.riis.com/blog/plugins-with-atak-civ-sdk-5-5
- Key source files analysed:
  - `ImportInternalSDResolver.java` — base class for file routing resolvers
  - `ImportGRGSort.java` — existing GRG sorter (only handles GeoTIFF/NITF/KMZ/PDF, not XML)
  - `MissionPackageEventHandler.java` — extraction pipeline that calls import sorters
  - `GRGDiscovery.java` — scanner that finds files in `atak/grg/` for the overlay manager
  - `MobacMapSourceFactory.java` — parser for `<customMapSource>` XML format
  - `HelloImportResolver.java` — example custom import resolver from plugin template
