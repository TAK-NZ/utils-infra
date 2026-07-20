#!/bin/bash

# Build TAK Server Maps Package
# Usage: ./build-maps-package.sh <domain> <taknz-api-key> <linz-api-key> [output-dir] [uuid]

set -e

# Check arguments
if [ $# -lt 3 ]; then
    echo "Usage: $0 <domain> <taknz-api-key> <linz-api-key> [output-dir] [uuid]"
    echo "Example: $0 example.com tk_abc123 your_linz_api_key ./output"
    echo "Example with UUID: $0 example.com tk_abc123 your_linz_api_key ./output 12345678-1234-1234-1234-123456789abc"
    exit 1
fi

DOMAIN="$1"
TAKNZ_API_KEY="$2"
LINZ_API_KEY="$3"
OUTPUT_DIR="${4:-./output}"
UUID="${5:-$(uuidgen)}"

# Create output directory and get absolute paths
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(realpath "$OUTPUT_DIR")
TEMP_DIR=$(mktemp -d)

echo "Building TAK Maps Package..."
echo "Domain: $DOMAIN"
echo "TAK.NZ API Key: ${TAKNZ_API_KEY:0:10}..."
echo "LINZ API Key: ${LINZ_API_KEY:0:10}..."
echo "UUID: $UUID"

# Get script directory and copy template files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR/maps-package/template/"* "$TEMP_DIR/"

# Replace template variables in all XML files
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{DOMAIN}}/$DOMAIN/g" {} \;
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{API_KEY}}/$TAKNZ_API_KEY/g" {} \;
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{LINZ_API_KEY}}/$LINZ_API_KEY/g" {} \;
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{UUID}}/$UUID/g" {} \;

# Create zip file in temp directory then move to output
cd "$TEMP_DIR"
FILENAME="TAK-NZ-Maps-Package-$UUID.zip"
zip -r "$FILENAME" ./*

# Move to output directory
OUTPUT_PATH="$OUTPUT_DIR/$FILENAME"
mv "$FILENAME" "$OUTPUT_PATH"

# Verify file was created
if [ -f "$OUTPUT_PATH" ]; then
    echo "✅ Maps package created: $OUTPUT_PATH"
    ls -la "$OUTPUT_PATH"
else
    echo "❌ Failed to create maps package at: $OUTPUT_PATH"
    exit 1
fi

# Cleanup
rm -rf "$TEMP_DIR"
