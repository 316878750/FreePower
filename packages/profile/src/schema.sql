-- 由 tools/gen-schema.mjs 生成，勿手改。
-- 形状：平铺大表 + 一个 fingerprint_config JSON 列（对齐 AdsPower 8.9.23 的存储形状）。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  proxy_type    TEXT NOT NULL CHECK (proxy_type IN ('http','https','socks5','ssh','none')),
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT,
  password      TEXT,
  remark        TEXT,
  ipchecker     TEXT,
  last_ip       TEXT,
  last_country  TEXT,
  last_region   TEXT,
  last_city     TEXT,
  last_tz       TEXT,
  checked_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernels (
  version     TEXT PRIMARY KEY,
  major       INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  path        TEXT,
  size_bytes  INTEGER,
  installed_at TEXT
);

CREATE TABLE IF NOT EXISTS launches (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  cdp_port    INTEGER NOT NULL,
  pid         INTEGER,
  ws_endpoint TEXT,
  args_json   TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS profile_tags (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, tag_id)
);

CREATE TABLE IF NOT EXISTS extensions (
  -- 应用中心：扩展库。**文件全局共享一份**（`<数据根>/ext_env/<id>/`），
  -- 每个环境启用哪些是环境级的（profile_extensions），见 docs/15。
  id               TEXT PRIMARY KEY,
  unique_id        TEXT,
  name             TEXT NOT NULL,
  version          TEXT,
  description      TEXT,
  manifest_version INTEGER,
  path             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT '1',
  source           TEXT,
  files            INTEGER,
  bytes            INTEGER,
  sha256           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS profile_extensions (
  profile_id TEXT NOT NULL,
  ext_id     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, ext_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  -- 自研扩展
  "id" TEXT,
  "profile_no" INTEGER,
  "fp_seed" INTEGER,
  "kernel_version" TEXT,
  "proxy_id" TEXT,
  "status" TEXT,
  "created_at" TEXT,
  "updated_at" TEXT,
  "last_launch_at" TEXT,
  "deleted_at" TEXT,

  -- 平铺字段（拆解表）
  "name" TEXT,
  "group_id" TEXT NOT NULL,
  "category_id" TEXT,
  "profile_tag_ids" TEXT,
  "remark" TEXT,
  "domain_name" TEXT,
  "open_urls" TEXT,
  "tabs" TEXT,
  "repeat_config" TEXT,
  "platform_account" TEXT,
  "cookie" TEXT,
  "username" TEXT,
  "password" TEXT,
  "fakey" TEXT,
  "login_user" TEXT,
  "login_user_comment" TEXT,
  "random_fingerprint" TEXT,
  "app_ids" TEXT,
  "sys_user_id" TEXT,
  "company_id" TEXT,
  "invite_code" TEXT,
  "ext_obj" TEXT,
  "browser" TEXT,
  "browser_kernel_config" TEXT,
  "browser_head" TEXT,
  "platform" TEXT,
  "new_mobile_mode" TEXT,
  "kernelSandboxMode" TEXT,
  "browser_compatibility_mode" TEXT,
  "gpu" TEXT,
  "gpu_switch" TEXT,
  "cdp_mask" TEXT,
  "ban_dev_tools" TEXT,
  "renderer_accessibility" TEXT,
  "device_scale" REAL,
  "virtual_camera" TEXT,
  "ua" TEXT,
  "client_hints" TEXT,
  "language" TEXT,
  "language_switch" TEXT,
  "lang" TEXT,
  "page_language" TEXT,
  "page_language_switch" TEXT,
  "timezone" TEXT,
  "automatic_timezone" TEXT,
  "canvas" TEXT,
  "canvas_id" INTEGER,
  "webgl_image" TEXT,
  "webgl_image_id" INTEGER,
  "webgl" TEXT,
  "webgl_config" TEXT,
  "audio" TEXT,
  "audio_id" INTEGER,
  "client_rects" TEXT,
  "client_rects_id" INTEGER,
  "dis_canvas_url" TEXT,
  "fonts" TEXT,
  "disabled_fonts" TEXT,
  "screen_resolution" TEXT,
  "hardware_concurrency" TEXT,
  "device_memory" TEXT,
  "device_name" TEXT,
  "device_name_switch" TEXT,
  "mac_address_config" TEXT,
  "gyroscope" TEXT,
  "network_information_type" TEXT,
  "media_devices" TEXT,
  "media_devices_num" TEXT,
  "media_devices_config" TEXT,
  "media_devices_config_v2" TEXT,
  "speech_switch" TEXT,
  "speech_voices" TEXT,
  "webrtc" TEXT,
  "user_proxy_config" TEXT,
  "ip" TEXT,
  "ip_country" TEXT,
  "ip_city" TEXT,
  "ip_region" TEXT,
  "ipchecker" TEXT,
  "is_multi_level_proxy" TEXT,
  "mutli_level_proxy" TEXT,
  "bypass_proxy_check" TEXT,
  "full_pac_url" TEXT,
  "scan_port_type" TEXT,
  "allow_scan_ports" TEXT,
  "location" TEXT,
  "location_switch" TEXT,
  "longitude" REAL,
  "latitude" REAL,
  "accuracy" REAL,
  "do_not_track" TEXT,
  "tls" TEXT,
  "tls_switch" TEXT,
  "flash" TEXT,
  "automation_controlled" TEXT,
  "disable_image" TEXT,
  "disable_video" TEXT,
  "image_size" INTEGER,
  "disable_console" TEXT,
  "disable_save_password" TEXT,
  "disable_password_filling" TEXT,
  "sync_password" TEXT,
  "fb_cloud_password_manager" TEXT,
  "open_google_api" TEXT,
  "translate_webpages" TEXT,
  "blacklist" TEXT,
  "whitelist" TEXT,
  "whitelist_open" TEXT,
  "domain_https" TEXT,
  "tabAssistantExt" TEXT,
  "tabAssistantFeatures" TEXT,
  "hidden_notification" TEXT,
  "launch_args" TEXT,
  "browser_run_args" TEXT,
  "no_args" TEXT,
  "cover_args" TEXT,
  "headless" TEXT,
  "optimize_launch" TEXT,
  "use_launch_optimize" TEXT,
  "open_tabs" TEXT,
  "new_startup_page" TEXT,
  "window_position" TEXT,
  "win_x" INTEGER,
  "win_y" INTEGER,
  "clear_cache_after_closing" TEXT,
  "cache_backup" TEXT,
  "storage_strategy" TEXT,
  "storage_cloud_option" TEXT,
  "sync_localstorage_cache" TEXT,
  "sync_indexeddb_cache" TEXT,
  "sync_extension_cache" TEXT,
  "sync_history" TEXT,
  "not_sync_cache_not_open" TEXT,
  "browser_security_lock" TEXT,
  "browser_security_lock_ignore_ids" TEXT,
  "api_merged" TEXT,
  "is_fb_network_acceleration" TEXT,
  "ignore_agent_config" TEXT,

  -- 结构化指纹对象
  "fingerprint_config" TEXT NOT NULL DEFAULT '{}',

  PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles("group_id");
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles("status");
CREATE INDEX IF NOT EXISTS idx_profiles_deleted ON profiles("deleted_at");
CREATE INDEX IF NOT EXISTS idx_launches_profile ON launches(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_extensions_ext ON profile_extensions(ext_id);
