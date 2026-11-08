-- workbase_test: revision 1 -> 2
CREATE TABLE "zakaznik" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "jmeno" TEXT NOT NULL,
  "email" TEXT,
  "telefon" TEXT,
  "adresa" TEXT,
  "poznamka" TEXT,
  UNIQUE (organization_id, id)
);
CREATE INDEX "zakaznik_org_idx" ON "zakaznik"(organization_id, id);

CREATE TABLE "sluzba" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "nazev" TEXT NOT NULL,
  "popis" TEXT,
  "cena" REAL NOT NULL,
  "delka_minut" INTEGER,
  "aktivni" INTEGER DEFAULT 1 CHECK ("aktivni" IN (0,1)),
  UNIQUE (organization_id, id)
);
CREATE INDEX "sluzba_org_idx" ON "sluzba"(organization_id, id);

CREATE TABLE "uklizecka" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "jmeno" TEXT NOT NULL,
  "email" TEXT,
  "telefon" TEXT,
  "aktivni" INTEGER DEFAULT 1 CHECK ("aktivni" IN (0,1)),
  UNIQUE (organization_id, id)
);
CREATE INDEX "uklizecka_org_idx" ON "uklizecka"(organization_id, id);

CREATE TABLE "dostupnost" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "uklizecka" TEXT NOT NULL,
  "od" TEXT NOT NULL,
  "do" TEXT NOT NULL,
  "poznamka" TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, "uklizecka") REFERENCES "uklizecka"(organization_id, id)
);
CREATE INDEX "dostupnost_org_idx" ON "dostupnost"(organization_id, id);
CREATE INDEX "dostupnost_uklizecka_idx" ON "dostupnost"(organization_id, "uklizecka");
CREATE TABLE "rezervace" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "zakaznik" TEXT NOT NULL,
  "sluzba" TEXT NOT NULL,
  "uklizecka" TEXT,
  "termin" TEXT NOT NULL,
  "adresa" TEXT,
  "cena" REAL,
  "stav" TEXT NOT NULL DEFAULT 'nova' CHECK ("stav" IN ('nova', 'potvrzena', 'hotova', 'zrusena')),
  "poznamka" TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, "zakaznik") REFERENCES "zakaznik"(organization_id, id),
  FOREIGN KEY (organization_id, "sluzba") REFERENCES "sluzba"(organization_id, id),
  FOREIGN KEY (organization_id, "uklizecka") REFERENCES "uklizecka"(organization_id, id)
);
CREATE INDEX "rezervace_org_idx" ON "rezervace"(organization_id, id);
CREATE INDEX "rezervace_zakaznik_idx" ON "rezervace"(organization_id, "zakaznik");
CREATE INDEX "rezervace_sluzba_idx" ON "rezervace"(organization_id, "sluzba");
CREATE INDEX "rezervace_uklizecka_idx" ON "rezervace"(organization_id, "uklizecka");
CREATE TABLE "ukol" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "rezervace" TEXT NOT NULL,
  "nazev" TEXT NOT NULL,
  "hotovo" INTEGER DEFAULT 0 CHECK ("hotovo" IN (0,1)),
  "poradi" INTEGER,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, "rezervace") REFERENCES "rezervace"(organization_id, id)
);
CREATE INDEX "ukol_org_idx" ON "ukol"(organization_id, id);
CREATE INDEX "ukol_rezervace_idx" ON "ukol"(organization_id, "rezervace");
CREATE TABLE "skoda" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "rezervace" TEXT NOT NULL,
  "popis" TEXT NOT NULL,
  "castka" REAL,
  "zapsano" TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, "rezervace") REFERENCES "rezervace"(organization_id, id)
);
CREATE INDEX "skoda_org_idx" ON "skoda"(organization_id, id);
CREATE INDEX "skoda_rezervace_idx" ON "skoda"(organization_id, "rezervace");
INSERT INTO instance_meta VALUES (2, '0.1.0', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
