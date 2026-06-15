# Fusion Engine (LIMES resolver)

The `gctrl-resolver` service: LIMES 1.8.1 link-discovery framework running its
Apache Spark REST server on `:8080`. FUSE's `ResolverClient` (`services/fuse/src/limes_client.py`)
uploads CSVs, submits a LIMES config, polls, and downloads the `accepted.nt` /
`review.nt` link files. Endpoints: `POST /upload`, `POST /submit`,
`GET /status/:id`, `GET /results/:id`, `GET /result/:id/:file`.

## The jar

`limes.jar` is the shaded `limes-core` jar (Main-Class
`org.aksw.limes.core.controller.Controller`). It is **architecture-independent**
JVM bytecode, so the image is multi-arch (amd64 + arm64) off a single jar.

Rebuild it from the LIMES source (kept at `DataBorg Github/LIMES-master/`) only
when LIMES changes:

```bash
cd "DataBorg Github/LIMES-master"
docker run --rm -v "$(pwd):/limes" -w /limes maven:3.8-eclipse-temurin-17 \
  mvn -q clean package shade:shade -Dmaven.test.skip=true -pl limes-core -am
cp limes-core/target/limes-core-1.8.1-SNAPSHOT.jar \
   ../../borghive/services/fusion-engine/limes.jar
```

(On Windows/git-bash prefix the docker command with `MSYS_NO_PATHCONV=1`.)

## Run

`docker run -p 8080:8080 ghcr.io/gctrl-tech/fusion-engine:latest` → server on
:8080 (the `-s` flag is the image default). The installer deploys it
automatically as `gctrl-resolver`; no user setup.
