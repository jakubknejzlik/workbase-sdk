-- SDK metadata upgrade only; domain revision and historical SQL remain unchanged.
UPDATE instance_meta SET core_version = '0.2.0' WHERE revision = (SELECT MAX(revision) FROM instance_meta);
