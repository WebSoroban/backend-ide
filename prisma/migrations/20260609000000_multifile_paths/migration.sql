-- Multi-file (multi-page) contract support.
--
-- Adds Project.manifestPath / Project.deployTarget and File.path, then backfills
-- File.path for every existing project by reproducing the EXACT flat->tree
-- mapping the build worker used to synthesize at compile time (root lib.rs was
-- copied to src/lib.rs, etc.). After the backfill the (projectId, path) unique
-- index is added. This is self-contained: `prisma migrate deploy` alone leaves
-- existing single-file projects compiling/deploying identically.
--
-- The same mapping lives in lib/paths.ts (legacyNameToPath) and is re-applied by
-- scripts/backfill-file-paths.ts for projects created by older code paths.

-- AlterTable: Project build config
ALTER TABLE "Project"
  ADD COLUMN     "manifestPath" TEXT NOT NULL DEFAULT 'Cargo.toml',
  ADD COLUMN     "deployTarget" TEXT;

-- AlterTable: track which workspace member a deployment targeted
ALTER TABLE "Deployment"
  ADD COLUMN     "deployTarget" TEXT;

-- AlterTable: File.path (temporary DEFAULT '' so the NOT NULL add succeeds on
-- existing rows; dropped after the backfill below).
ALTER TABLE "File"
  ADD COLUMN     "path" TEXT NOT NULL DEFAULT '';

-- Data backfill: map each file's flat name to its tree path, then de-dup any
-- collisions (e.g. a project containing both lib.rs and main.rs) by prefixing
-- the 2nd+ occurrence with "dupN/" so the unique index can be created safely.
WITH mapped AS (
  SELECT
    "id",
    "projectId",
    CASE
      WHEN TRIM("name") LIKE '%/%'                              THEN regexp_replace(TRIM("name"), '^\./', '')
      WHEN TRIM("name") IN ('Cargo.toml', 'Cargo.lock')        THEN TRIM("name")
      WHEN lower(TRIM("name")) IN ('lib.rs', 'main.rs')        THEN 'src/lib.rs'
      WHEN lower(TRIM("name")) IN ('test.rs', 'tests.rs')      THEN 'tests/test.rs'
      WHEN lower(TRIM("name")) LIKE '%.rs'                     THEN 'src/' || TRIM("name")
      ELSE TRIM("name")
    END AS p
  FROM "File"
),
ranked AS (
  SELECT
    "id",
    p,
    row_number() OVER (PARTITION BY "projectId", p ORDER BY "id") AS rn
  FROM mapped
)
UPDATE "File" f
SET "path" = CASE WHEN r.rn = 1 THEN r.p ELSE 'dup' || r.rn || '/' || r.p END
FROM ranked r
WHERE f."id" = r."id";

-- Drop the temporary default — new rows always supply an explicit path.
ALTER TABLE "File" ALTER COLUMN "path" DROP DEFAULT;

-- CreateIndex: enforce one file per (project, path).
CREATE UNIQUE INDEX "File_projectId_path_key" ON "File"("projectId", "path");
