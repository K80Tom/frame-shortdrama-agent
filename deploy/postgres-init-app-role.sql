\set ON_ERROR_STOP on

-- Secrets stay in the one-shot container environment instead of being expanded
-- into Compose command arguments or printed by this script.
\getenv app_user POSTGRES_APP_USER
\getenv app_password POSTGRES_APP_PASSWORD
\getenv admin_password PGPASSWORD

-- Only roles in Lyra's namespace may be managed here.  This prevents a typo
-- such as POSTGRES_APP_USER=postgres (or a pg_* system role) from having its
-- privileges and memberships rewritten by the bootstrap container.
SELECT :'app_user' !~ '^lyra_[a-z0-9_]{1,58}$' AS app_user_invalid \gset
\if :app_user_invalid
  \echo 'POSTGRES_APP_USER must start with lyra_ and contain only lowercase letters, digits or underscores.'
  DO $$ BEGIN RAISE EXCEPTION 'LYRA_APP_ROLE_NAME_INVALID'; END $$;
\endif

SELECT :'app_user' = current_user AS app_is_admin \gset
\if :app_is_admin
  \echo 'POSTGRES_APP_USER must differ from the migration administrator.'
  DO $$ BEGIN RAISE EXCEPTION 'LYRA_APP_ROLE_EQUALS_ADMIN'; END $$;
\endif

SELECT :'app_password' = :'admin_password' AS password_reused \gset
\if :password_reused
  \echo 'POSTGRES_APP_PASSWORD must differ from POSTGRES_PASSWORD.'
  DO $$ BEGIN RAISE EXCEPTION 'LYRA_APP_ROLE_PASSWORD_REUSED'; END $$;
\endif

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') AS app_role_exists \gset
\if :app_role_exists
  SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') <> 'lyra-managed-stage1-application-role:v1'
    AS app_role_unmanaged
  FROM pg_roles
  WHERE rolname = :'app_user'
  \gset
  \if :app_role_unmanaged
    \echo 'POSTGRES_APP_USER already exists but is not marked as a Lyra-managed application role.'
    DO $$ BEGIN RAISE EXCEPTION 'LYRA_APP_ROLE_UNMANAGED'; END $$;
  \endif
  SELECT format(
    'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
    :'app_user', :'app_password'
  ) \gexec
\else
  SELECT format(
    'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
    :'app_user', :'app_password'
  ) \gexec
  SELECT format(
    'COMMENT ON ROLE %I IS %L',
    :'app_user', 'lyra-managed-stage1-application-role:v1'
  ) \gexec
\endif

-- NOINHERIT does not prevent SET ROLE. Remove any stale memberships and role
-- defaults that could re-enable privileged access or lyra.system_bypass.
SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted ON granted.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname = :'app_user'
\gexec
SELECT format('ALTER ROLE %I RESET ALL', :'app_user') \gexec
SELECT format('ALTER ROLE %I IN DATABASE %I RESET ALL', :'app_user', current_database()) \gexec

SELECT EXISTS (
  SELECT 1 FROM pg_database database_record
  JOIN pg_roles owner_role ON owner_role.oid = database_record.datdba
  WHERE database_record.datname = current_database() AND owner_role.rolname = :'app_user'
  UNION ALL
  SELECT 1 FROM pg_namespace namespace_record
  JOIN pg_roles owner_role ON owner_role.oid = namespace_record.nspowner
  WHERE owner_role.rolname = :'app_user'
  UNION ALL
  SELECT 1 FROM pg_class relation_record
  JOIN pg_roles owner_role ON owner_role.oid = relation_record.relowner
  WHERE owner_role.rolname = :'app_user' AND relation_record.relpersistence <> 't'
  UNION ALL
  SELECT 1 FROM pg_proc function_record
  JOIN pg_roles owner_role ON owner_role.oid = function_record.proowner
  WHERE owner_role.rolname = :'app_user'
) AS app_owns_objects \gset
\if :app_owns_objects
  \echo 'Application role owns database objects; reassign them to the migration administrator before startup.'
  DO $$ BEGIN RAISE EXCEPTION 'LYRA_APP_ROLE_OWNS_OBJECTS'; END $$;
\endif

-- Reconcile existing objects for upgrades from an older Compose volume. The
-- application gets data-plane privileges only; migrations keep ownership.
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'app_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'app_user') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'app_user') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'app_user') \gexec

-- Every migration runs as the current administrator. These defaults make new
-- tables usable by API/Worker without ever making the application their owner.
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  current_user, :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  current_user, :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
  current_user, :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE ON TYPES TO %I',
  current_user, :'app_user'
) \gexec

SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname = :'app_user';
