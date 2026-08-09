-- ============================================================
-- PetZone Queue Management System - Database Schema
-- Import this file directly in cPanel → phpMyAdmin → Import
-- No migrations needed — run once on a fresh database
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ── Organizations (SaaS tenants) ──────────────────────────
CREATE TABLE IF NOT EXISTS qms_organizations (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  slug          VARCHAR(80)  NOT NULL UNIQUE,
  logo_url      VARCHAR(255) DEFAULT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Branches (clinic locations per organization) ──────────
CREATE TABLE IF NOT EXISTS qms_branches (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  org_id        INT UNSIGNED NOT NULL,
  name          VARCHAR(150) NOT NULL,
  slug          VARCHAR(80)  NOT NULL,
  address       VARCHAR(255) DEFAULT NULL,
  phone         VARCHAR(30)  DEFAULT NULL,
  counter_pin   VARCHAR(32)  DEFAULT NULL,
  kiosk_pin     VARCHAR(32)  DEFAULT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branch_slug_org (org_id, slug),
  CONSTRAINT fk_branch_org FOREIGN KEY (org_id) REFERENCES qms_organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Users (super_admin | org_admin | branch_staff) ────────
CREATE TABLE IF NOT EXISTS qms_users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  org_id        INT UNSIGNED DEFAULT NULL,
  branch_id     INT UNSIGNED DEFAULT NULL,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('super_admin','org_admin','branch_staff') NOT NULL DEFAULT 'branch_staff',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_org    FOREIGN KEY (org_id)    REFERENCES qms_organizations(id) ON DELETE SET NULL,
  CONSTRAINT fk_user_branch FOREIGN KEY (branch_id) REFERENCES qms_branches(id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Service types (Consultation, Vaccination, etc.) ─────────
CREATE TABLE IF NOT EXISTS qms_service_types (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id     INT UNSIGNED NOT NULL,
  name          VARCHAR(100) NOT NULL,
  prefix        VARCHAR(5)   NOT NULL DEFAULT 'A',
  color         VARCHAR(7)   NOT NULL DEFAULT '#1E3A8A',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  display_order INT          NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_service_branch FOREIGN KEY (branch_id) REFERENCES qms_branches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Counters (staff desks) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS qms_counters (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id        INT UNSIGNED NOT NULL,
  name             VARCHAR(80)  NOT NULL,
  service_type_id  INT UNSIGNED DEFAULT NULL,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_counter_branch FOREIGN KEY (branch_id)       REFERENCES qms_branches(id)       ON DELETE CASCADE,
  CONSTRAINT fk_counter_service FOREIGN KEY (service_type_id) REFERENCES qms_service_types(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Queue tickets (daily number slips) ──────────────────────
CREATE TABLE IF NOT EXISTS qms_tickets (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id       INT UNSIGNED NOT NULL,
  service_type_id INT UNSIGNED NOT NULL,
  counter_id      INT UNSIGNED DEFAULT NULL,
  ticket_number   INT UNSIGNED NOT NULL,
  ticket_code     VARCHAR(20)  NOT NULL,
  pet_name        VARCHAR(100) DEFAULT NULL,
  owner_name      VARCHAR(120) DEFAULT NULL,
  status          ENUM('waiting','called','serving','completed','skipped','cancelled') NOT NULL DEFAULT 'waiting',
  date_key        DATE         NOT NULL,
  issued_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  called_at       DATETIME     DEFAULT NULL,
  completed_at    DATETIME     DEFAULT NULL,
  CONSTRAINT fk_ticket_branch  FOREIGN KEY (branch_id)       REFERENCES qms_branches(id)       ON DELETE CASCADE,
  CONSTRAINT fk_ticket_service FOREIGN KEY (service_type_id) REFERENCES qms_service_types(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_counter FOREIGN KEY (counter_id)    REFERENCES qms_counters(id)       ON DELETE SET NULL,
  UNIQUE KEY uq_ticket_daily (branch_id, service_type_id, date_key, ticket_number),
  KEY idx_ticket_status (branch_id, date_key, status),
  KEY idx_ticket_code   (ticket_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Clinic group chat (OPD ↔ Reception / Cashier) ───────────
CREATE TABLE IF NOT EXISTS qms_chat_messages (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id    INT UNSIGNED NOT NULL,
  sender_name  VARCHAR(80)  NOT NULL,
  sender_role  VARCHAR(40)  DEFAULT NULL,
  body         VARCHAR(500) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chat_branch FOREIGN KEY (branch_id) REFERENCES qms_branches(id) ON DELETE CASCADE,
  KEY idx_chat_branch_id (branch_id, id),
  KEY idx_chat_branch_created (branch_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Daily sequence tracker (fast ticket numbering) ──────────
CREATE TABLE IF NOT EXISTS qms_daily_sequences (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id       INT UNSIGNED NOT NULL,
  service_type_id INT UNSIGNED NOT NULL,
  date_key        DATE         NOT NULL,
  last_number     INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_sequence (branch_id, service_type_id, date_key),
  CONSTRAINT fk_seq_branch  FOREIGN KEY (branch_id)       REFERENCES qms_branches(id)       ON DELETE CASCADE,
  CONSTRAINT fk_seq_service FOREIGN KEY (service_type_id) REFERENCES qms_service_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- Seed data: PetZone demo organization + default admin
-- Default login: admin@petzone.com / Petzone@123
-- Password hash generated with bcrypt (10 rounds)
-- ============================================================

INSERT INTO qms_organizations (name, slug) VALUES
  ('PetZone Hospital', 'petzone');

SET @org_id = LAST_INSERT_ID();

INSERT INTO qms_branches (org_id, name, slug, address, phone) VALUES
  (@org_id, 'PetZone Main Clinic', 'main', '123 Pet Care Avenue, Karachi', '+92-300-1234567'),
  (@org_id, 'PetZone North Branch', 'north', '45 Animal Street, Islamabad', '+92-300-7654321');

SET @branch_main = (SELECT id FROM qms_branches WHERE slug = 'main' AND org_id = @org_id LIMIT 1);

SET @branch_north = (SELECT id FROM qms_branches WHERE slug = 'north' AND org_id = @org_id LIMIT 1);

INSERT INTO qms_service_types (branch_id, name, prefix, color, display_order) VALUES
  (@branch_main, 'General Consultation', 'C', '#1E3A8A', 1),
  (@branch_main, 'Grooming', 'G', '#D97706', 3),
  (@branch_north, 'General Consultation', 'C', '#1E3A8A', 1),
  (@branch_north, 'Grooming', 'G', '#D97706', 3);

INSERT INTO qms_counters (branch_id, name, service_type_id) VALUES
  (@branch_main, 'OPD 1', (SELECT id FROM qms_service_types WHERE branch_id = @branch_main AND prefix = 'C' LIMIT 1)),
  (@branch_main, 'OPD 2', (SELECT id FROM qms_service_types WHERE branch_id = @branch_main AND prefix = 'C' LIMIT 1)),
  (@branch_main, 'Grooming', (SELECT id FROM qms_service_types WHERE branch_id = @branch_main AND prefix = 'G' LIMIT 1)),
  (@branch_north, 'OPD 1', (SELECT id FROM qms_service_types WHERE branch_id = @branch_north AND prefix = 'C' LIMIT 1)),
  (@branch_north, 'Grooming', (SELECT id FROM qms_service_types WHERE branch_id = @branch_north AND prefix = 'G' LIMIT 1));

-- bcrypt hash for: Petzone@123
INSERT INTO qms_users (org_id, branch_id, name, email, password_hash, role) VALUES
  (NULL, NULL, 'Super Admin', 'admin@petzone.com',
   '$2b$10$OcQwME/sBPpNk.DexH8YaeIgNoB40MjPkDg5Zxgo1h10hCN8AExHi',
   'super_admin');
