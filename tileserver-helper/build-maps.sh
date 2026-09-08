#!/bin/bash

# Build TAK Map Source XML Files for Device Profile / Manual ATAK Installation
#
# Each map source stays as an individual customMapSource XML file (no zip,
# no Mission Package manifest). Per TAK Server Device Profile docs, map
# source XML files must be uploaded individually to the Device Profile
# Manager (one PUT per file) — wrapping them in a Mission Package zip causes
# them to show up as user-deletable Data Packages in ATAK's Overlay Manager
# instead of being cleanly imported as map sources.
#
# Usage: ./build-maps.sh <domain> <taknz-api-key> <linz-api-key> [output-dir]

set -e

# Check arguments
if [ $# -lt 3 ]; then
    echo "Usage: $0 <domain> <taknz-api-key> <linz-api-key> [output-dir]"
    echo "Example: $0 example.com tk_abc123 your_linz_api_key ./maps-output"
    exit 1
fi

DOMAIN="$1"
TAKNZ_API_KEY="$2"
LINZ_API_KEY="$3"
OUTPUT_DIR="${4:-./maps-output}"

# Create output directory and get absolute path
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(realpath "$OUTPUT_DIR")

echo "Building TAK Map Source XML Files..."
echo "Domain: $DOMAIN"
echo "TAK.NZ API Key: ${TAKNZ_API_KEY:0:10}..."
echo "LINZ API Key: ${LINZ_API_KEY:0:10}..."
echo "Output: $OUTPUT_DIR"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Process each customMapSource XML template into the output directory as a
# standalone file.
for template in "$SCRIPT_DIR/maps/template/"*.xml; do
    [[ -f "$template" ]] || continue
    filename=$(basename "$template")
    echo "Processing: $filename"

    sed \
        -e "s/{{DOMAIN}}/$DOMAIN/g" \
        -e "s/{{API_KEY}}/$TAKNZ_API_KEY/g" \
        -e "s/{{LINZ_API_KEY}}/$LINZ_API_KEY/g" \
        "$template" > "$OUTPUT_DIR/$filename"
done

echo ""
echo "✅ Map source files created in: $OUTPUT_DIR"
echo ""
echo "Installation Instructions:"
echo "1. Device Profile (recommended): upload each file individually via"
echo "   PUT /Marti/api/device/profile/<profile>/file?filename=<filename>"
echo "   (one file per call — do NOT zip these together)"
echo "2. Manual ATAK install:"
echo "   - copy the XML files to Internal storage/atak/maps/"
echo "   then restart ATAK"

ls -la "$OUTPUT_DIR"
