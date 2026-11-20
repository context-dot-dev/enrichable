ALTER TABLE enrichable.organization_providers DROP CONSTRAINT IF EXISTS organization_providers_provider_check;
ALTER TABLE enrichable.organization_providers ADD CONSTRAINT organization_providers_provider_check CHECK (provider IN ('openai','context','typesafe','hunter','prospeo','quickenrich','apollo','contactout','leadmagic'));
