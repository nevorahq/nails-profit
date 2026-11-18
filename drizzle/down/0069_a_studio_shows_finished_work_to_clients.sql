-- Rollback for 0069: a studio shows finished work to clients.
--
-- Only the publications go: the photos themselves stay on their visits and in
-- the bucket. The public page simply has nothing to show again.

DROP TABLE IF EXISTS "gallery_photo";
