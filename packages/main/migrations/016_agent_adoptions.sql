-- Production auto mode may adopt only candidates that already passed the
-- deterministic plan/storyboard validators. Public HTTP flows still use user.
ALTER TABLE plan_adoptions
  DROP CONSTRAINT plan_adoptions_actor_check;
ALTER TABLE plan_adoptions
  ADD CONSTRAINT plan_adoptions_actor_check CHECK (actor IN ('user', 'agent'));

ALTER TABLE storyboard_adoptions
  DROP CONSTRAINT storyboard_adoptions_actor_check;
ALTER TABLE storyboard_adoptions
  ADD CONSTRAINT storyboard_adoptions_actor_check CHECK (actor IN ('user', 'agent'));
