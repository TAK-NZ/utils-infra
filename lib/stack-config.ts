/**
 * Configuration interface for EtlUtils stack template
 * This makes the stack reusable across different projects and environments
 */

/**
 * MBTiles configuration for tileserver-gl
 */
export interface MBTilesConfig {
  enabled: boolean;
  s3Key: string;
  filename: string;
}

/**
 * Multiple MBTiles configuration for tileserver-gl
 */
export interface MBTilesMultiConfig {
  enabled: boolean;
  files: MBTilesConfig[];
}

/**
 * Container configuration for individual services
 */
export interface ContainerConfig {
  enabled: boolean;
  path?: string;
  hostname?: string;
  healthCheckPath: string;
  port: number;
  cpu: number;
  memory: number;
  priority?: number;
  imageTag: string;
  mbtiles?: MBTilesConfig;
  mbtilesMulti?: MBTilesMultiConfig;
}

/**
 * Terrain proxy: LINZ elevation to TAK terrain tiles, as an AWS Lambda function behind the ALB (not an ECS container).
 * Source: the terrain-proxy/ folder of this repository (see docs/TERRAIN_PROXY.md).
 */
export interface TerrainProxyConfig {
  enabled: boolean;
  /** Hostname label under the hosted zone, e.g. "terrain". CloudFront and the ALB rule both use it. */
  hostname: string;
  /** ALB listener rule priority; must be unique across the listener. */
  priority: number;
  /** Version label. The build workflows push the image as "utils-terrain-proxy-<imageTag>" and skip the build when
   *  that tag already exists, so bump it whenever the terrain-proxy code or its Dockerfile changes. */
  imageTag: string;
  /** Memory for the function in MB. Lambda gives CPU in proportion, and a tile is mostly CPU work. */
  memorySize: number;
  /** Timeout in seconds. Keep it under the ALB idle timeout (60 s) so a slow tile returns a clean error. */
  timeoutSeconds: number;
  /** Optional cap on parallel executions, to limit how hard a burst of uncached tiles hits the LINZ API. Unset by
   *  default: AWS keeps 100 units of the account limit unreserved, so this can be at most (account limit - 100). */
  reservedConcurrency?: number;
}

/**
 * SAR engine: terrain-aware travel-time analysis for search and rescue, as AWS Lambda functions.
 * Source: the sar-engine/ folder of this repository (see docs/SAR_ENGINE.md).
 */
export interface SarEngineConfig {
  /** Off by default: enabling needs the image to exist in ECR and the data to be uploaded first. */
  enabled: boolean;
  /** ALB path prefix with a trailing slash, e.g. "/sar/" (the listener rule becomes "/sar/*"). */
  path: string;
  /** ALB listener rule priority; must be unique across the listener. */
  priority: number;
  /** Version label. The build workflows push the image as "utils-sar-engine-<imageTag>-<7 characters of a hash of the
   *  files the image copies>", so any change to the engine code yields a new tag; bump imageTag as well to keep the
   *  label meaningful. */
  imageTag: string;
  /** Memory for the HTTP function in MB (2048 is ample; peak use measured at about 350 MB). */
  memorySize: number;
  /** Timeout in seconds. Keep it under the ALB idle timeout (60 s) so a slow run returns a clean error. */
  timeoutSeconds: number;
  /** Optional cap on parallel runs. Unset by default: AWS keeps 100 units of the account limit unreserved, so
   *  this can be at most (account concurrency limit - 100), and reserving fails on accounts with a low limit. */
  reservedConcurrency?: number;
  /** Key prefix in the artifacts bucket for the data (land cover raster, OSM snapshots). */
  dataPrefix: string;
  /** Object in the config bucket holding the API keys (see nz/api_keys.py in sar-engine). */
  apiKeysConfigKey: string;
  /** Monthly refresh of the OpenStreetMap snapshot. */
  osmRefresh: {
    enabled: boolean;
    /** Day of month, 1 to 28. */
    dayOfMonth: number;
    /** Hour of day, 0 to 23, UTC. */
    hourUtc: number;
  };
}

/**
 * Context-based configuration interface matching cdk.context.json structure
 */
export interface ContextEnvironmentConfig {
  stackName: string;
  utilsHostname: string;
  ecs: {
    taskCpu: number;
    taskMemory: number;
    desiredCount: number;
    enableDetailedLogging: boolean;
    enableEcsExec: boolean;
  };
  containers: {
    [key: string]: ContainerConfig;
  };
  general: {
    removalPolicy: string;
    enableDetailedLogging: boolean;
  };
  docker: {
    usePreBuiltImages: boolean;
  };
  terrainProxy?: TerrainProxyConfig;
  sarEngine?: SarEngineConfig;
  sitrep?: {
    enabled: boolean;
    /** Bare Bedrock model id, e.g. "anthropic.claude-sonnet-5" — no region-profile
     * prefix (us./au./etc). The SitRep Lambda resolves the correct prefix for
     * its own deploy region at runtime, so this works unchanged in any region. */
    modelId?: string;
  };
  cloudfront?: {
    tileserver?: {
      enabled: boolean;
      cacheTtl?: {
        tiles?: string;
        metadata?: string;
        health?: string;
      };
    };
    display?: {
      enabled: boolean;
      hostname: string;
    };
  };
}