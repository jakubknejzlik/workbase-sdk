-- SDK metadata upgrade 0.2.0 -> 0.2.1 only; domain revision and historical SQL remain unchanged.
UPDATE instance_meta SET core_version = '0.2.1' WHERE revision = (SELECT MAX(revision) FROM instance_meta);
