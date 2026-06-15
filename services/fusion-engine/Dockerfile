# GCTRL Fusion Engine — LIMES link-discovery REST resolver (Apache Spark server
# on :8080). FUSE's ResolverClient talks to this for the high-precision entity
# resolution stage; without it FUSE silently degrades to the O(n²) Python matcher.
#
# The jar is architecture-independent Java bytecode, so a multi-arch JRE base
# yields a genuine linux/amd64 + linux/arm64 image (native on Apple Silicon) with
# a trivial package step — no cross-compilation, no QEMU build. The jar is built
# once from LIMES 1.8.1 (see README.md) and committed alongside this Dockerfile.
FROM eclipse-temurin:17-jre
WORKDIR /
VOLUME /data
VOLUME /.server-storage
COPY limes.jar /limes.jar
EXPOSE 8080
# Controller starts the Spark server ONLY with `-s` (Server.getInstance().run on
# defaultPort 8080); with no args it runs the CLI and exits. Default to server
# mode so the image serves even when compose passes no command. The --add-opens
# flags grant the reflective access Spark/Jetty/Jena need under the JPMS module
# system (JDK 16+).
ENTRYPOINT ["java", \
  "--add-opens", "java.base/java.lang=ALL-UNNAMED", \
  "--add-opens", "java.base/java.lang.invoke=ALL-UNNAMED", \
  "--add-opens", "java.base/java.util=ALL-UNNAMED", \
  "--add-opens", "java.base/java.net=ALL-UNNAMED", \
  "-jar", "/limes.jar"]
CMD ["-s"]
