# Brain iceberg-rest catalog image = apache/iceberg-rest-fixture + the PostgreSQL
# JDBC driver, which the upstream fixture image does NOT bundle. Against an Aurora
# JdbcCatalog the stock image dies at startup with:
#   java.sql.SQLException: No suitable driver found for jdbc:postgresql://...
#
# The fixture launches its 192MB fat jar via `java -jar`, which IGNORES -cp /
# CLASSPATH — so we drop the driver alongside it and relaunch the SAME main class
# (org.apache.iceberg.rest.RESTCatalogServer, confirmed from the fixture's stack)
# with an explicit -cp that includes both jars. All CATALOG_* config still comes
# from the pod env (set by the helm chart); nothing else changes.
ARG PG_DRIVER_VERSION=42.7.4

FROM alpine:3.20 AS driver
ARG PG_DRIVER_VERSION
RUN apk add --no-cache curl \
 && curl -fsSL -o /postgresql.jar \
      "https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_DRIVER_VERSION}/postgresql-${PG_DRIVER_VERSION}.jar"

FROM apache/iceberg-rest-fixture:1.9.2
COPY --from=driver /postgresql.jar /usr/lib/iceberg-rest/postgresql.jar
# Preserve any JAVA_OPTS; run the fixture's own main class with the driver on -cp.
ENTRYPOINT ["sh","-c","exec java ${JAVA_OPTS:-} -cp /usr/lib/iceberg-rest/iceberg-rest-adapter.jar:/usr/lib/iceberg-rest/postgresql.jar org.apache.iceberg.rest.RESTCatalogServer"]
