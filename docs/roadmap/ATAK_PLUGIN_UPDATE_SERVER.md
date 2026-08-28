# ATAK Plugin Update Server — Version-Scoped Plugin Distribution

> **Status: not implemented.** This is a design/roadmap document, not a
> description of the current deployment. All work described here is tracked
> in GitHub issue [#110](https://github.com/TAK-NZ/utils-infra/issues/110) and
> its sub-issues (#112–#117). Check those issues for current status before
> assuming anything below is built. This doc lives in `docs/roadmap/`
> specifically to keep unimplemented design work visually and physically
> separate from `docs/` (which documents the system as it actually exists
> today). This feature lives in **utils-infra**, not tak-infra — see
> [#110](https://github.com/TAK-NZ/utils-infra/issues/110) for the repo
> decision — despite this doc having originally been drafted alongside
> `tak-infra`'s other roadmap docs.

Tags: #tak-server #atak #plugins #update-server #cloudfront #s3 #tak-gov #lambda

Reference notes on ATAK's "Update Server" feature (TAK Package MGMT preferences → Update Server), which is the correct mechanism for distributing a **different plugin APK per ATAK version**. This is a completely separate system from Device Profiles (see `DEVICE_PROFILES.md`) — read the "Is this part of TAK Server?" section first, since it changes how this gets deployed.

---

## Is this part of TAK Server? No.

`atakUpdateServerUrl` (the "Update Server" field under TAK Package MGMT preferences in ATAK) is just a **plain HTTPS URL that ATAK does a GET request against**. It is not a TAK Server API. Confirmed by reading the TAK Server source (`/home/ubuntu/GitHub/TAK-NZ/TPC_TAK_Server`):

- TAK Server's entire HTTP surface is a servlet webapp (`Marti.war`) rooted at `/Marti/...` — every endpoint is a `@RequestMapping`-annotated REST controller (`ProfileAPI`, `ProfileAdminAPI`, `MissionApi`, etc.) or a fixed static resource under `takserver-core/src/main/webapp/{Marti,user-management,register,setup,locate}`. There is no `/update` path and no controller anywhere that serves or accepts `product.inf`/`product.infz`.
- `security-context.xml` (which enumerates every path TAK Server actually serves) has no `/update/**` entry at all.
- In this deployment (`tak-infra`), `tak.demo.tak.nz` is a single Route 53 alias record pointed at TAK Server's Network Load Balancer (`lib/constructs/route53.ts`), which only forwards fixed TAK Server ports (80, 443→8446, 8089, 8443, 8446, 9001 — `TAK_SERVER_PORTS` in `lib/utils/constants.ts`) into TAK Server's own servlet paths. There's no static-file-serving construct anywhere in `lib/`.

So this needs a **new, separate piece of infrastructure**: a small static file host, reachable over HTTPS, that has nothing to do with the TAK Server ECS service, database, or load balancer. It doesn't need to live under the TAK Server domain at all — a dedicated subdomain (e.g. `updates.tak.nz`) is cleaner since it's an unrelated concern.

### Where the client-side logic actually lives

Traced from ATAK-CIV source, `com.atakmap.android.update.RemoteProductProvider`:

- `atakUpdateServerUrl` / `appMgmtEnableUpdateServer` are plain ATAK preferences read straight into an HTTPS GET. No TAK-Server-specific protocol, no client cert requirement — the only hard constraint is HTTPS (`RemoteProductProvider.rebuild()` explicitly rejects non-`https://` URLs).
- Before fetching, ATAK automatically tries a **version-specific subpath first**:
  ```java
  private static String getVersionApi() {
      String actualApi = ATAKConstants.getAbiVersion();
      ...
  }
  ```
  and in `getFile()`:
  ```java
  String api = getVersionApi();   // e.g. "5.7"
  if (url.contains("product.inf")) {
      url = url.replace("product.inf", api + "/product.inf");
  } else if (url.endsWith("/")) {
      url = url + api;
  } else {
      url = url + "/" + api;
  }
  ```
  If that request fails (404/connection error), ATAK falls back to the flat, non-versioned URL. The result of the first successful attempt is cached via the `foundVersionSpecifcRepo` preference, so once a version subfolder is found, it keeps using that path.
- That's the entire targeting mechanism: ATAK requests `<base>/<its own ABI version>/product.inf`, else `<base>/product.inf`. No group scoping, no cert-based targeting, no server-side logic required.

---

## What needs to be hosted

A static directory tree, served over HTTPS:

```
https://<update-host>/
├── product.inf              ← fallback index (flat / version-agnostic)
├── 5.4/
│   ├── product.inf
│   └── ATAK-Plugin-datasync-3.5.30-6fabb35e-5.4.0-civ-release.apk
├── 5.5/
│   ├── product.inf
│   └── ATAK-Plugin-datasync-3.5.32-7878c349-5.5.0-civ-release.apk
├── 5.6/
│   ├── product.inf
│   └── ATAK-Plugin-datasync-3.7.4-58746181-5.6.0-civ-release.apk
└── 5.7/
    ├── product.inf
    └── ATAK-Plugin-datasync-4.0.4-a858109b-5.7.0-civ-release.apk
```

### `product.inf` format

Parsed by `ProductInformation.create()`. One APK per comma-delimited line, 12+ columns (extra trailing columns tolerated up to 20 total):

```
Android,plugin,<packageName>,<displayName>,<version>,<revisionCode>,<apkUrl>,<iconUrl>,<description>,<md5hash>,<osRequirement>,<takRequirement>[,<fileSizeBytes>]
```

| # | Field | Notes |
|---|---|---|
| 1 | Platform | Must be `Android` |
| 2 | Product type | `plugin`, `app`, or `systemplugin` |
| 3 | Package name | Android package id |
| 4 | Display name | Shown in ATAK's App Management UI |
| 5 | Version | Free-text, display only |
| 6 | Revision code | Integer, compared against installed `versionCode` to detect updates |
| 7 | APK URL | Absolute, or relative to the `product.inf` location (filename alone works if the APK sits alongside it) |
| 8 | Icon URL | Optional, can be empty |
| 9 | Description | Optional; escape commas as `\u002c`, newlines as `\n` |
| 10 | MD5 hash | Verifies download integrity |
| 11 | OS requirement | Minimum Android API level |
| 12 | `takRequirement` | Plugin-API string the APK was built against. Separate compatibility check — used by `AtakPluginRegistry.isTakCompatible()` at plugin **load** time, independent of which version folder served the file |
| 13 (optional) | File size (bytes) | Informational only |

Two distinct things to keep straight:
1. **Which version-folder is fetched** = purely the requesting ATAK client's own ABI version, matched by URL path segment. You control this only by what you place in each folder.
2. **Whether the plugin loads once installed** = ATAK comparing the plugin's declared plugin-API (from its manifest, echoed as `takRequirement`) against the running ATAK's plugin API. Getting the folder targeting right doesn't help if the APK inside was built for the wrong ATAK release.

---

## Architecture: S3 + CloudFront

> **Note:** the sections below were originally drafted assuming this doc lived in
> `tak-infra`. The repo decision ([#110](https://github.com/TAK-NZ/utils-infra/issues/110))
> landed on `utils-infra` instead — see "Where should this be built" further down
> for that reasoning. `utils-infra` already uses the exact same
> `createBaseImportValue`/`BASE_EXPORT_NAMES` import pattern referenced below
> (see `lib/utils-infra-stack.ts`), and already hosts several small independent
> services the same way (`TerrainCloudFront`, `DisplayCloudFront`,
> `SitRepLambda` in `lib/constructs/`), so the architecture itself is unchanged
> — only the repo/file paths referenced below should read `utils-infra` /
> `utils-infra-stack.ts` instead of `tak-infra` / `tak-infra-stack.ts`.

Since this repo's infra is AWS CDK-based and there's no existing static-hosting construct, the natural fit is a small dedicated construct added to `utils-infra`:

```
Route53 (updates.<hostedZone>)
        │  A/AAAA alias
        ▼
   CloudFront distribution (HTTPS only, ACM cert)
        │  OAC (Origin Access Control)
        ▼
   S3 bucket (private, versioned)
        ├── product.inf
        ├── 5.4/product.inf, 5.4/*.apk
        ├── 5.5/product.inf, 5.5/*.apk
        └── ...
```

Why CloudFront rather than S3 static website hosting directly:
- S3 website endpoints are HTTP-only (or require your own TLS in front) — CloudFront gives you the HTTPS termination ATAK's Update Server requires, using an ACM certificate the same way `Elb`/`Route53` constructs already do for TAK Server.
- Keeps the S3 bucket fully private (Origin Access Control), rather than a public bucket/website endpoint.
- Free tier and caching are appropriate for a low-traffic, rarely-changing set of files like this.

### New dedicated bucket, not a subfolder of the existing config bucket

This repo already imports an S3 bucket from base-infra for TAK Server's own config (`BASE_EXPORT_NAMES.S3_ENV_CONFIG`, referenced in `tak-infra-stack.ts` as `s3Bucket` / `storage.s3.configBucket`). It's tempting to reuse it with an `update-server/` prefix instead of standing up a new bucket, but that bucket is the wrong fit here:

- **Ownership/lifecycle boundary.** It's imported via `s3.Bucket.fromBucketArn(...)` — base-infra owns its lifecycle (versioning, removal policy), not `tak-infra`. Attaching a CloudFront OAC bucket policy and a `BucketDeployment` to a bucket this stack doesn't own risks colliding with how base-infra manages it.
- **Security posture.** That bucket holds `takserver-config.env` and `takserver-plugins/*` config, read by the ECS task role. Wiring in a public-facing CloudFront distribution — even scoped to a prefix — widens the blast radius of a bucket that's otherwise strictly internal/server-side.
- **Lifecycle/retention needs differ.** Plugin APK distribution content is public, versioned per ATAK release, and may get pruned independently over time. That shouldn't share a removal/versioning policy with live server config.

The other existing base-infra bucket (`S3_ID` / `S3TAKImagesArnOutput`, holding `takserver-docker-*.zip` installer artifacts) isn't a better fit either — it's also base-infra-owned and holds internal build-time artifacts, not content meant for public CDN distribution.

**Decision: provision a new, dedicated S3 bucket owned by `tak-infra`** (created fresh in the `UpdateServer` construct below, not imported), so the Update Server's bucket policy, versioning, and removal policy can be managed independently and the blast radius of any CloudFront/OAC misconfiguration is limited to plugin APKs (public by design) rather than server config.

### Suggested CDK shape (new construct, e.g. `lib/constructs/update-server.ts`)

Following the existing pattern in this repo (`Elb`, `Route53` constructs import the hosted zone/cert from base-infra via `createBaseImportValue`/`BASE_EXPORT_NAMES`):

```typescript
import { Construct } from 'constructs';
import {
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_certificatemanager as acm,
  Fn,
  RemovalPolicy
} from 'aws-cdk-lib';

export interface UpdateServerProps {
  hostedZoneId: string;      // Fn.importValue(...) from base-infra, same pattern as Elb/Route53
  hostedZoneName: string;
  sslCertificateArn: string; // must be in us-east-1 for CloudFront
  hostname: string;          // e.g. "updates"
}

export class UpdateServer extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: UpdateServerProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: Fn.importValue(props.hostedZoneId),
      zoneName: Fn.importValue(props.hostedZoneName)
    });

    const fqdn = `${props.hostname}.${Fn.importValue(props.hostedZoneName)}`;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED
      },
      domainNames: [fqdn],
      certificate: acm.Certificate.fromCertificateArn(this, 'Cert', props.sslCertificateArn)
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.hostname,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution))
    });
  }
}
```

Notes specific to this repo's conventions:
- The bucket is created fresh (`new s3.Bucket(...)`) rather than importing the base-infra config bucket (`BASE_EXPORT_NAMES.S3_ENV_CONFIG`) — see "New dedicated bucket" above for why.
- The ACM certificate imported via `BASE_EXPORT_NAMES.CERTIFICATE_ARN` must be in **us-east-1** for CloudFront regardless of which region the rest of the stack runs in — confirm the base-infra cert is issued there, or provision a separate one.
- Deploy the APK/`product.inf` tree with a CDK `BucketDeployment` (`aws-cdk-lib/aws-s3-deployment`) pointing at a local `update-server/` source directory in this repo, so the file tree is versioned alongside the CDK code rather than uploaded out-of-band.
- Add a `CfnOutput` for the distribution's domain name / FQDN, matching the existing `TakServerUrl`/`TakServiceUrl` output pattern in `tak-infra-stack.ts`.

### Non-CDK alternative

If a full CDK construct is overkill for now: a manually-created S3 bucket + CloudFront distribution (via console or a one-off script) works identically from ATAK's perspective — it only cares that the final URL serves the files over HTTPS. The CDK approach above is preferable long-term since it keeps this reproducible alongside the rest of `tak-infra`.

---

## Setup steps

1. **Collect one APK per supported ATAK version.** Already available under `scripts/deviceprofiles/standard-plugins/template/plugins/` in this repo — reuse the same files.
2. **Build the directory layout above** locally (e.g. `update-server/` in this repo), with one `product.inf` per version folder plus a flat fallback `product.inf` at the root.
3. **Deploy the S3 + CloudFront stack/construct** and upload the tree (via `BucketDeployment` in CDK, or `aws s3 sync` if deploying manually).
4. **Point ATAK at it.** Settings → TAK Package MGMT → enable "Update Server" → set URL to the CloudFront/Route53 FQDN, e.g. `https://updates.tak.nz/`.
5. **Verify per version** — test with at least two different ATAK client versions, or manually curl each version-folder URL to confirm each returns the correct `product.inf`/APK pairing.

### Automating `product.inf` generation

MD5 hashes and revision codes must stay in sync with the actual APK files. A generator script (not present in this repo today) should:
- Compute `md5sum` per APK.
- Extract `versionCode` from each APK's manifest (`aapt dump badging`, or reuse a value already known from the plugin's own CI/build).
- Emit one `product.inf` line per APK, per version folder.

This is a natural companion to `build-standard-plugins-device-profile.sh`, which already tracks the version→APK mapping — the same table could drive both scripts.

---

## Configuring clients via `config.pref` (Device Profile settings push)

Rather than asking every user to manually type the Update Server URL into TAK Package MGMT preferences, push the settings through the existing settings Device Profile (`scripts/deviceprofiles/standard-settings/config.pref`, uploaded per `DEVICE_PROFILES.md`). All three relevant preferences live in the standard Android `SharedPreferences` store — confirmed by reading `AtakPreferences` (`PreferenceManager.getDefaultSharedPreferences()`), the exact same store the `com.atakmap.app_preferences` block in `.pref` files loads into. So this is just more entries in the same `<preference name="com.atakmap.app_preferences">` section already used for `deviceProfileEnableOnConnect`, etc.

Preference keys, confirmed from `app_mgmt_preferences.xml` and `AppMgmtPreferenceFragment`:

| Key | Type | Purpose |
|---|---|---|
| `appMgmtEnableUpdateServer` | `java.lang.Boolean` | Enables the Update Server feature (must be `true` for `atakUpdateServerUrl` to take effect — it's set as an Android `dependency` on that preference in the XML) |
| `atakUpdateServerUrl` | `java.lang.String` | The Update Server base URL, e.g. `https://updates.tak.nz/` |

Add to `config.pref`:

```xml
<entry key="appMgmtEnableUpdateServer" class="class java.lang.Boolean">true</entry>
<entry key="atakUpdateServerUrl" class="class java.lang.String">https://updates.tak.nz/</entry>
```

Optional related keys also visible in the same preferences screen, not required unless you need them:
- `updateServerCaLocation` (`java.lang.String`, default `"(built-in)"`) — custom CA truststore path if the Update Server's cert isn't in ATAK's built-in trust store (shouldn't be needed for a public ACM/CloudFront cert).
- `updateServerCaPassword` — password for that truststore, stored via `EncryptedPanEditTextPreference` (encrypted preference; not something to embed in plaintext `.pref` — leave unset if using a public CA-signed cert).
- `repoStartupSync` (`java.lang.Boolean`) — if `true`, ATAK automatically syncs the repo on startup rather than requiring the user to manually trigger it from App Management. Worth setting to `true` alongside the Update Server config so plugin updates actually get pulled without user action.

---

## Disabling EUD Link Capability

Separate from the Update Server, but related — you also want to disable ATAK's "EUD Link" feature (the cloud-based `tak.gov` plugin/map-source sync described in the previous research, distinct from both Device Profiles and Update Server). This is controlled by a single preference, confirmed in `control_preferences.xml` and its consumer `EudApiMapComponent.java`:

| Key | Type | Purpose |
|---|---|---|
| `eud_api_disable_option` | `java.lang.Boolean` | UI label: "Disable EUD Link Capability". When `true`, hides the EUD Link toolbar button/menu entry, unregisters its preferences screen, and if the device was already linked, unlinks it (`client.unlink()`) or evicts any synced resources (`client.evictResources(-1)`) |

Traced the exact effect in `EudApiMapComponent.configureLinkEudVisibility()`:
```java
if (!_prefs.get("eud_api_disable_option", false)) {
    // EUD Link button/preferences visible, resources sync normally
} else {
    NavButtonManager.getInstance().removeButtonModel(_model);
    ToolsPreferenceFragment.unregister("eud_link_preference");
    if (client != null) {
        if (client.isLinked())
            client.unlink();
        else
            client.evictResources(-1);
    }
}
```

This is a live listener (`_prefsListener`), not just a load-time check — pushing this via a Device Profile settings update will actively unlink an already-linked device and remove the UI, not merely prevent future linking.

Add to `config.pref`:

```xml
<entry key="eud_api_disable_option" class="class java.lang.Boolean">true</entry>
```

### Combined `config.pref` addition

```xml
<preference version="1" name="com.atakmap.app_preferences">
    <!-- ... existing entries (deviceProfileEnableOnConnect, etc.) ... -->

    <!-- Point ATAK at the self-hosted plugin Update Server (S3 + CloudFront) -->
    <entry key="appMgmtEnableUpdateServer" class="class java.lang.Boolean">true</entry>
    <entry key="atakUpdateServerUrl" class="class java.lang.String">https://updates.tak.nz/</entry>
    <entry key="repoStartupSync" class="class java.lang.Boolean">true</entry>

    <!-- Disable ATAK's cloud EUD Link feature (tak.gov-hosted plugin/map-source sync) -->
    <entry key="eud_api_disable_option" class="class java.lang.Boolean">true</entry>
</preference>
```

Push this update the same way as any other settings change: bump `config.pref`, re-upload it via `PUT /Marti/api/device/profile/{name}/file?filename=config.pref` (per `DEVICE_PROFILES.md`). Since `device_profile.updated` bumps on any file change in that profile, this re-syncs on next client connect and unlinks any already-linked devices immediately (per the live-listener behavior above), without waiting for a manual App Management sync.

---

## Update Server vs. Device Profiles — when to use which

| | Device Profiles | Update Server |
|---|---|---|
| Delivery | Push (automatic on enrollment/connect) | Pull (user opens App Management and syncs) |
| Backing system | TAK Server (`/Marti/api/device/profile`) | Separate static host — **not** TAK Server (proposed: S3 + CloudFront) |
| ATAK version awareness | None — server has no concept of client version | Built-in — client requests its own ABI-version subfolder automatically |
| Targeting axis | TAK Server groups (bitwise group-vector match) | ATAK ABI version only — no group/user targeting |
| Good for | Settings, icon sets, map sources, terrain manifests, plugins where per-group targeting matters | Plugin APKs specifically, where different builds are needed per ATAK version |

For plugins specifically, Update Server is the more correct, purpose-built mechanism — it removes the need to maintain separate Device Profile groups just to fan out plugin versions. Device Profiles can still push a plugin's `plugin.xml` + `.apk` (as documented in `DEVICE_PROFILES.md`), but that puts version targeting on you via TAK Server groups; Update Server does the version targeting client-side, for free, at the cost of being pull- rather than push-based.

---

## Automatic sync with tak.gov

You mentioned `TAK-Portal` (`/home/ubuntu/GitHub/TAK-NZ/TAK-Portal`) already does something like this "although with a UI we don't need" plus "automatic sync with tak.gov." Worth being precise about what that repo actually does before treating it as a blueprint, since it's not quite what the phrase "automatic sync" suggests.

### What TAK-Portal actually implements — and what it doesn't

TAK-Portal has **no Update Server implementation at all**. A full-repo search for `product.inf`, `revisionCode`/`revision_code`, and `update-server` turns up nothing. What it has instead is an unrelated admin feature, a **"Plugin Manager"** page (`views/plugin-manager.ejs`, `routes/plugins.routes.js`, `services/plugins.service.js`) that lets an admin manually browse and download individual ATAK plugin APKs from tak.gov's catalog API into local storage, plus a separate read-only `/plugins` page where any logged-in user can download whatever's been cached locally. There's no `product.inf` generation, no per-ATAK-version folder layout, and no S3 — storage is a flat `data/plugins/` directory on local disk with a sidecar `data/plugin-manifest.json` for metadata (name, filename, `package_name`, `version`, `revision_code`, `source`, etc — see `loadManifest()`/`saveManifest()` in `services/plugins.service.js`).

More importantly, the tak.gov "sync" is **not automatic**. There is no cron job, no scheduler, no webhook — I checked for `node-cron`/`node-schedule`/`setInterval` tied to plugins and found none (the only `setInterval` in the repo is an unrelated self-update-version-check for the portal itself). Every fetch from tak.gov — requesting the device code, exchanging it for a token, listing available plugin versions, downloading a specific APK, checking for updates — is triggered by an admin clicking a button in `plugin-manager.ejs`. So "automatic sync with tak.gov" is really "a UI for an admin to manually pull individual plugins from tak.gov, one click at a time," not a background process. This matches your instinct that the UI itself isn't something we need — but it also means there's no scheduling/automation logic in that repo to reuse either. We'd be building that piece from scratch either way.

### What's genuinely worth reusing: the tak.gov OAuth + fetch mechanics

The one part of `services/plugins.service.js` worth porting is the protocol-level handling of tak.gov's API, which has some non-obvious quirks:

- **Auth is OAuth 2.0 Device Authorization Grant** (the same "go to this URL, enter this code" flow used for CLI tools), not a static API key. Endpoints: `https://auth.tak.gov/auth/realms/TPC/protocol/openid-connect/auth/device` (device code) and `.../protocol/openid-connect/token` (token exchange/refresh), client id `tak-gov-eud`.
- **tak.gov requires HTTP/2** — it returns `421` over HTTP/1.1. TAK-Portal handles this with two different tools: raw Node `http2` module for the auth/token/list JSON calls (`takGovHttp2Post`/`takGovHttp2Get`), and `undici`'s `fetch` with `new Agent({ allowH2: true })` for streaming the actual APK binary download (`takGovFetchStreamToFile`).
- **Plugin catalog**: `GET https://tak.gov/eud_api/software/v1/plugins?product=<ATAK-CIV>&product_version=<x.y.z>`, Bearer-authenticated, returns a list of plugin entries (each with `apk_url`, `display_name`, `package_name`, `version`, `revision_code`, `atak_version`/`product_version`, `apk_size_bytes`).
- **No "list available versions" endpoint exists.** TAK-Portal works around this by brute-force probing a rolling range of ATAK version strings (5.0.0–5.12.0, 6.0.0–6.6.0) against the plugins-list endpoint and keeping whichever return success (`listTakGovAvailableVersions`). Worth reusing this same probing approach rather than hardcoding a version list, since tak.gov gives no better option.
- **Refresh tokens, not long-lived access tokens.** Every catalog/download call exchanges the stored `refresh_token` for a fresh `access_token` first (`getTakGovAccessToken`). If tak.gov invalidates the refresh token, TAK-Portal detects known "session expired" error markers and clears the stored link so a human has to re-authorize.
- **APK filename comes from the `Content-Disposition` header** on the download response, not from the catalog metadata — the catalog only gives you the download URL.

### Design: a scheduled Lambda that does what TAK-Portal's admin does, minus the human

To get true automatic sync (not a UI a human has to operate), the natural fit given this repo's existing AWS CDK/serverless patterns (see `lambda/geojson-query/`, `lib/constructs/bedrock-geojson-lambda.ts`) is an **EventBridge-scheduled Lambda** that performs the same tak.gov calls TAK-Portal's admin UI does, but on a timer, writing results straight into the Update Server's S3 bucket instead of local disk:

```
EventBridge Schedule (e.g. daily)
        │
        ▼
Lambda: tak-gov-sync
  1. Refresh access_token (refresh_token from Secrets Manager)
  2. For each ATAK version we care about (explicit list, not probed —
     see below) x each product we track (ATAK-CIV):
       GET /eud_api/software/v1/plugins?product=...&product_version=...
  3. Diff each entry's revision_code against what's already in
     the version-folder's product.inf on S3
  4. For anything new/changed: download the APK (HTTP/2 fetch),
     compute MD5, write APK + updated product.inf to S3
        │
        ▼
   S3 bucket (same bucket as the Update Server construct above)
        │
        ▼
   CloudFront (existing distribution — cache invalidation on
   product.inf paths after each sync run)
```

Key differences from TAK-Portal's approach, deliberately:

- **Explicit version list, not brute-force probing.** TAK-Portal's version-probing hack (trying every `5.x.0`/`6.x.0` combination) makes sense for an interactive browser UI where discovery matters. For an unattended sync job, prefer an explicit, reviewed list of ATAK versions this deployment actually supports (matching whatever versions already have folders under `update-server/` — see the Setup steps above) — fewer tak.gov API calls, and no risk of silently starting to distribute a plugin build for a version we haven't validated.
- **`refresh_token` in Secrets Manager, not a JSON file.** TAK-Portal's `linked`/`refreshToken` state lives in `data/plugin-manifest.json` on local disk. In this repo's Lambda, store it in AWS Secrets Manager (consistent with how `takSecrets` are already handled in `tak-infra-stack.ts`) and grant the Lambda's execution role `secretsmanager:GetSecretValue`/`PutSecretValue` (needed because tak.gov rotates the refresh token on every exchange, per `getTakGovAccessToken`'s handling of `data.refresh_token`).
- **One-time manual step stays manual: initial device-code linking.** The OAuth device-authorization flow is inherently interactive — a human has to visit tak.gov and enter a code. That can't be automated away, and doesn't need to be a full UI either — a one-off CLI/script (`scripts/tak-gov-link.sh` or similar) that prints the code + verification URL and waits for confirmation, run once to seed the refresh token into Secrets Manager, covers it. This is the one piece of "the UI we don't need" that still needs *some* interactive surface, just not a persistent one.
- **Sync writes S3 objects directly**, not local files + JSON manifest — `product.inf` regeneration reuses the same generator logic proposed in "Automating `product.inf` generation" above, just triggered by the Lambda instead of run manually.
- **Revision-code diffing replaces TAK-Portal's `isNewerVersion`/`getUpdateStatus` check** — same idea (compare `revision_code` between what's stored and what tak.gov currently reports), just running unattended per scheduled invocation instead of per button click.

### Do we have everything needed to implement this?

Resolved:

1. **Product tier**: ATAK-CIV only.
2. **tak.gov account**: to be provided once implementation starts.
3. **Redistribution terms**: all synced plugins will be freely downloadable — no access-control requirement on the CloudFront/S3 side for tak.gov-sourced content.
4. **Plugin allow-list**: to be provided once implementation starts; the sync will initially cover only the "DataSync" plugin (already tracked in this repo as one of the standard plugins pushed via Device Profiles — see `scripts/deviceprofiles/standard-plugins/template/plugins/plugin-*.xml`, e.g. `ATAK-Plugin-datasync-*-civ-release.apk`), with room to expand the allow-list later without infrastructure changes. Note: the exact Android `package_name` tak.gov's catalog uses for this plugin isn't confirmed in this repo's config today (the device-profile XML references it by display name/APK filename, not package id) — that'll need to be looked up against the tak.gov catalog response when building the allow-list.

The mechanics (OAuth device flow, HTTP/2 requirement, catalog/download endpoints, revision-code comparison) are all confirmed from TAK-Portal's working implementation, so this is ready to scope into concrete build tasks.

## Where should this be built: `tak-infra`, or a dedicated repo?

**Recommendation: a dedicated repo, not `tak-infra`.**

The strongest precedent in this GitHub org is `utils-infra` (`/home/ubuntu/GitHub/TAK-NZ/utils-infra`) — a standalone CDK repo, independent of `tak-infra`, that imports directly from `base-infra` (VPC, hosted zone, certificate — via the same `createBaseImportValue`/`BASE_EXPORT_NAMES` pattern) and hosts several unrelated small services behind their own CloudFront distributions and Lambdas (`TerrainCloudFront`, `DisplayCloudFront`, `SitRepLambda`), all under their own subdomain (`utils.{domain}`). That's exactly the shape of what an Update Server + tak.gov sync needs: its own domain, own CloudFront/S3, own scheduled Lambda with its own secrets — none of it related to TAK Server's ECS service, database, or NLB.

Reasons not to fold this into `tak-infra`:
- **Deploy/rollback coupling.** `tak-infra` deploys are gated on TAK Server config and database state. Plugin distribution has no relationship to that lifecycle — bundling them means unrelated changes start blocking or triggering each other's deploys.
- **IAM surface.** The sync Lambda needs Secrets Manager access for the tak.gov refresh token and outbound internet access to tak.gov's API. Keeping that out of `tak-infra`'s stack avoids growing its IAM footprint for a third-party integration that has nothing to do with TAK Server itself.
- **Independent release cadence.** The plugin allow-list will grow over time (starting with just the data sync plugin per above) — that should ship as a config change, not a `tak-infra` CDK deploy.
- **Matches existing org convention.** `utils-infra` already establishes "one CDK repo per logical auxiliary service" as the pattern here, rather than growing any one layer stack to cover unrelated concerns.

Open question, lower stakes than the repo-vs-`tak-infra` decision: whether this becomes its own new repo (e.g. `atak-update-server`) or a new service folder inside `utils-infra` itself (which already hosts multiple small independent services). Given this needs its own subdomain, own CloudFront distribution, and a scheduled Lambda handling OAuth secrets — a materially different shape from `utils-infra`'s current ALB-routed proxy services — a dedicated new repo is the cleaner fit, but this is a closer call than the primary "not `tak-infra`" recommendation.

## Should this get an admin web UI with OIDC auth?

**No — not recommended.** Given how the rest of this design has landed (scheduled Lambda, static S3/CloudFront distribution, config-as-data allow-list), a persistent admin web app has no real job to do:

- **Manual re-sync** → covered by invoking the Lambda directly (`aws lambda invoke` or the Lambda console's "Test" button) — the same way this org already operates comparable scheduled Lambdas (e.g. `SitRepLambda` in `utils-infra`). No trigger UI exists for those either.
- **Allow-list edits** → this is a config value, not a live admin action — better kept as an SSM Parameter or CDK-managed config (a one-line CLI command or PR to change), consistent with how this org manages config everywhere else, rather than a database-backed form.
- **Sync visibility** → CloudWatch Logs plus a CloudWatch alarm → SNS/email on failure covers it. If a friendlier view is wanted, the cheapest option is a static `sync-status.json` written to the same S3 bucket each run (last run time, revision codes synced) — no auth needed since it's just metadata, not sensitive, and nothing in the sync design is sensitive enough to gate behind a login.
- **Distribution itself needs no auth at all** — you've confirmed all synced plugins are freely downloadable, so there's no access-control surface for a UI to manage in the first place.

Building a UI anyway means standing up and indefinitely maintaining a stateful app — session handling, an OIDC client integration, somewhere to actually run it (another ECS service or Lambda+API Gateway), ongoing patching — to functionally reproduce TAK-Portal's Plugin Manager, which is the piece you already said isn't needed. Every other part of this design is static or serverless with nothing to operate; a login-gated admin app breaks that for marginal convenience over an `aws lambda invoke` call and an SSM parameter edit.

**If a genuine need for restricted actions shows up later** (e.g. manually deleting a synced plugin, approving new allow-list entries), the right tool in this org isn't a custom Express/session app like TAK-Portal's — it's **ALB-native OIDC against Authentik**, already implemented in `auth-infra` for the enrollment flow (`lib/constructs/enroll-alb-oidc-auth.ts`: an ALB listener rule with a built-in OIDC authenticate action, backed by Authentik as the IdP). That pattern means the ALB itself handles the entire OAuth exchange and only forwards already-authenticated requests to a target — no custom auth code to write or maintain. Worth reaching for only when a concrete authenticated action is needed, not preemptively.

---

## Sources consulted

- ATAK-CIV: `com.atakmap.android.update.RemoteProductProvider` (version-subfolder request logic, `getVersionApi()`, `getFile()`); `com.atakmap.android.update.ProductInformation` (`product.inf` line format/parsing); `com.atak.plugins.impl.AtakPluginRegistry` (`isTakCompatible()`, plugin-API load-time check); `com.atakmap.app.preferences.AppMgmtPreferenceFragment` / `AppMgmtActivity` (preference keys `atakUpdateServerUrl`, `appMgmtEnableUpdateServer`); `res/xml/app_mgmt_preferences.xml`, `res/xml/control_preferences.xml` (preference key definitions/types/dependencies); `com.atakmap.android.eud.EudApiMapComponent` (`eud_api_disable_option` consumer, `configureLinkEudVisibility()`); `com.atakmap.android.preference.AtakPreferences` (confirms `.pref` `com.atakmap.app_preferences` block maps to `PreferenceManager.getDefaultSharedPreferences()`, the same store all these keys read from)
- TAK Server: `security-context.xml` and all `@RequestMapping` controllers under `com.bbn.marti.*` — no `/update` or `product.inf` handling found anywhere
- tak-infra: `lib/constructs/route53.ts`, `lib/constructs/elb.ts`, `lib/utils/constants.ts`, `lib/tak-infra-stack.ts` — confirms `tak.demo.tak.nz` resolves only to TAK Server's fixed NLB ports, no static hosting present today; used as the reference for CDK construct conventions (hosted zone/cert import via `createBaseImportValue`, `CfnOutput` pattern). `lambda/geojson-query/`, `lib/constructs/bedrock-geojson-lambda.ts` — reference pattern for this repo's existing CDK-managed Lambda constructs, used as the model for the proposed `tak-gov-sync` Lambda.
- TAK-Portal (`/home/ubuntu/GitHub/TAK-NZ/TAK-Portal`): `services/plugins.service.js` (OAuth 2.0 Device Authorization Grant flow against `auth.tak.gov`, HTTP/2 handling via Node `http2` and `undici`'s `Agent({ allowH2: true })`, tak.gov plugin catalog endpoint `eud_api/software/v1/plugins`, version-probing discovery, refresh-token handling, APK download via `Content-Disposition` filename extraction); `routes/plugins.routes.js`, `views/plugin-manager.ejs`, `views/plugins.ejs` (admin/end-user UI, confirmed to have no relation to ATAK's actual Update Server protocol — no `product.inf` generation anywhere in the repo, confirmed via full-repo search)
