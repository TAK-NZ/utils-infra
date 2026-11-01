# TAK-NZ terrain-proxy as an AWS Lambda container image, invoked by the Application Load Balancer.
# The CI build workflows and the CDK deploy build it for linux/amd64. Lambda rejects images with attestation manifests,
# so build with: docker build --platform linux/amd64 --provenance=false --sbom=false -t terrain-proxy ./terrain-proxy
# To run the Express server directly instead (local development), use: node server.js
FROM public.ecr.aws/lambda/nodejs:24

COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --omit=dev

COPY server.js lambda.js t3-taknz.json NZGeoid2016.gtx ${LAMBDA_TASK_ROOT}/

# Lambda runs the function as an unprivileged user, not root. COPY keeps the file modes of the build context, so a
# builder with a restrictive umask (modes 600/700) would produce an image whose code only root can read.
RUN chmod -R a+rX ${LAMBDA_TASK_ROOT}

# Build-time guard: load the handler as an unprivileged user, as Lambda will. A permission or missing-library problem
# (for example the native sharp binary) now fails the build, instead of failing every request after deployment.
RUN node -e "process.setgid(1000); process.setuid(1000); require('./lambda.js'); console.log('handler loads as uid 1000')"

CMD ["lambda.handler"]
