// src/lib/system/migrationManifest.ts
//
// **자동 생성 파일. 손으로 고치지 마세요.**
// 만드는 곳: scripts/gen-migration-manifest.mjs
// 다시 만들기: npm run gen:migrations
//
// 이 목록은 "지금 코드가 요구하는 마이그레이션"이다. DB의
// schema_migrations 표와 비교해서 무엇이 남았는지 화면에 적는다.
// CI(scripts/check-migrations.mjs)가 이 파일이 낡았으면 실패시킨다.

export interface ManifestEntry {
  name: string;
  id: number;
  risk: 'ADDITIVE' | 'DESTRUCTIVE' | 'UNKNOWN';
  /** 파일 내용의 sha256 앞 16자 — 적용된 뒤 파일이 바뀌었는지 본다 */
  checksum: string;
}

export const MIGRATION_MANIFEST: ManifestEntry[] = [
  { name: '000_schema_migrations.sql', id: 0, risk: 'ADDITIVE', checksum: '4962f719fd32fc97' },
  { name: '001_kill_switch_bootstrap.sql', id: 1, risk: 'ADDITIVE', checksum: '46b3fa1d3834923b' },
  { name: '002_profiles_admin.sql', id: 2, risk: 'ADDITIVE', checksum: '03ce6d0e31894fa5' },
  { name: '003_login_sessions.sql', id: 3, risk: 'ADDITIVE', checksum: 'd82594762f0e9e5b' },
  { name: '004_exchange_connections.sql', id: 4, risk: 'ADDITIVE', checksum: '20e4438486625b52' },
  { name: '005_user_strategies.sql', id: 5, risk: 'ADDITIVE', checksum: 'dad9db1508be0650' },
  { name: '006_admin_notices.sql', id: 6, risk: 'ADDITIVE', checksum: 'f719c780645b3b4c' },
  { name: '007_webhook_dedup.sql', id: 7, risk: 'ADDITIVE', checksum: '9b3994c985078583' },
  { name: '008_signals.sql', id: 8, risk: 'ADDITIVE', checksum: '90fc3e44051dce68' },
  { name: '009_position_plans.sql', id: 9, risk: 'ADDITIVE', checksum: 'c1a979b23dd7c757' },
  { name: '010_paper_trading.sql', id: 10, risk: 'ADDITIVE', checksum: '72ca9ce858ca11e6' },
  { name: '011_ai_usage.sql', id: 11, risk: 'ADDITIVE', checksum: 'b21bef74fee58926' },
  { name: '012_live_orders.sql', id: 12, risk: 'ADDITIVE', checksum: 'fe2a2570333e075f' },
  { name: '013_daily_slots.sql', id: 13, risk: 'ADDITIVE', checksum: 'b3db9f25360bc8f0' },
  { name: '014_derivatives_daily.sql', id: 14, risk: 'ADDITIVE', checksum: '23649da90e6c1a19' },
  { name: '015_econ_events.sql', id: 15, risk: 'ADDITIVE', checksum: '6ed5e16c0c071a4b' },
  { name: '016_profiles_align.sql', id: 16, risk: 'ADDITIVE', checksum: 'cec5f8e23b201bd4' },
  { name: '017_ladder_cycles.sql', id: 17, risk: 'ADDITIVE', checksum: '057230de8f790c92' },
  { name: '018_live_orders_recovery.sql', id: 18, risk: 'ADDITIVE', checksum: '78008ac0042633f1' },
  { name: '019_news_articles.sql', id: 19, risk: 'ADDITIVE', checksum: 'f939be625f2fd4f3' },
  { name: '020_ai_usage_detail.sql', id: 20, risk: 'ADDITIVE', checksum: '939a1e135829de32' },
  { name: '021_grant_owner_role.sql', id: 21, risk: 'ADDITIVE', checksum: 'b4f62c6b75d880f0' },
  { name: '022_rls_worker_tables.sql', id: 22, risk: 'UNKNOWN', checksum: '1b3c51365bf1e2f9' },
  { name: '023_ai_predictions.sql', id: 23, risk: 'ADDITIVE', checksum: '4cc2372f4de06415' },
  { name: '024_sub_accounts.sql', id: 24, risk: 'ADDITIVE', checksum: 'df33b4fbb9d41c5f' },
  { name: '025_paper_market.sql', id: 25, risk: 'ADDITIVE', checksum: 'e5de7a309cda9ffd' },
  { name: '026_safety_events.sql', id: 26, risk: 'ADDITIVE', checksum: '6b1ddb8d49630bd8' },
  { name: '027_econ_time_known.sql', id: 27, risk: 'ADDITIVE', checksum: 'a013b27dc37c5b9a' },
  { name: '028_kis_connection.sql', id: 28, risk: 'ADDITIVE', checksum: '1e05af1c4d9780ae' },
  { name: '029_cron_runs.sql', id: 29, risk: 'ADDITIVE', checksum: '50f60c22deb683b4' },
  { name: '030_trader_signals.sql', id: 30, risk: 'ADDITIVE', checksum: '87bd4575268d6a5f' },
  { name: '031_autotrade_schedule.sql', id: 31, risk: 'ADDITIVE', checksum: 'cac1e1c7596381bd' },
  { name: '032_scheduled_exits.sql', id: 32, risk: 'ADDITIVE', checksum: '6e01f5164cb3f3d9' },
  { name: '033_paper_margin_mode.sql', id: 33, risk: 'ADDITIVE', checksum: 'e884fd9a0122cab5' },
  { name: '034_autotrade_sizing.sql', id: 34, risk: 'ADDITIVE', checksum: 'e25bdb840fd923c1' },
  { name: '035_autotrade_interval.sql', id: 35, risk: 'ADDITIVE', checksum: '9114ff147a0aa46a' },
  { name: '036_autotrade_margin_pct.sql', id: 36, risk: 'ADDITIVE', checksum: 'aa19f291625e7444' },
  { name: '037_creator_ledger.sql', id: 37, risk: 'ADDITIVE', checksum: '0c31da2c4504c780' },
  { name: '038_webhook_secrets.sql', id: 38, risk: 'ADDITIVE', checksum: '7e6ea076ab4dec4f' },
  { name: '039_trading_capability.sql', id: 39, risk: 'ADDITIVE', checksum: '73d2babcf711f4d2' },
  { name: '040_audit_events.sql', id: 40, risk: 'ADDITIVE', checksum: 'eeaf16de222f35fc' },
  { name: '041_strategy_accounts.sql', id: 41, risk: 'ADDITIVE', checksum: 'f74f2d6202c3ce97' },
  { name: '042_sleeve_cost_basis.sql', id: 42, risk: 'ADDITIVE', checksum: '04168d7a3643e023' },
  { name: '043_autotrade_last_decision.sql', id: 43, risk: 'ADDITIVE', checksum: '06770aaaf34667cc' },
  { name: '044_runtime_jobs.sql', id: 44, risk: 'ADDITIVE', checksum: 'b81b13c90b1026ee' },
  { name: '045_user_strategies.sql', id: 45, risk: 'ADDITIVE', checksum: '4ee9c50f7310ed95' },
  { name: '046_mock_sessions.sql', id: 46, risk: 'ADDITIVE', checksum: '1888a5530ef8bdf3' },
  { name: '048_account_equity_snapshots.sql', id: 48, risk: 'ADDITIVE', checksum: '94b904caf84fe0a5' },
  { name: '050_schedule_strategy.sql', id: 50, risk: 'UNKNOWN', checksum: 'af576f09705c6eeb' },
  { name: '051_strategy_cycles.sql', id: 51, risk: 'ADDITIVE', checksum: '14ea5ebc80da6109' },
  { name: '052_smoke_tests.sql', id: 52, risk: 'ADDITIVE', checksum: 'fbecd22200630fd5' },
  { name: '053_smoke_runs.sql', id: 53, risk: 'ADDITIVE', checksum: '4f3611260e0199e5' },
  { name: '054_worker_version.sql', id: 54, risk: 'ADDITIVE', checksum: 'f3bf8284689191f8' },
  { name: '055_smoke_cancel.sql', id: 55, risk: 'ADDITIVE', checksum: '00694ca473e93cf3' },
  { name: '056_ledger_events.sql', id: 56, risk: 'ADDITIVE', checksum: 'bb5fda192a7a30db' },
  { name: '057_worker_runtime.sql', id: 57, risk: 'ADDITIVE', checksum: '0a975e0ca5e287af' },
  { name: '058_exit_monitor_runs.sql', id: 58, risk: 'ADDITIVE', checksum: '6898a6d6b5cdd060' },
  { name: '059_ops_requests.sql', id: 59, risk: 'ADDITIVE', checksum: '3d014c816a33bf6c' },
  { name: '060_ops_bootstrap.sql', id: 60, risk: 'ADDITIVE', checksum: 'dde6ca4cdd62c43a' },
  { name: '061_self_heal.sql', id: 61, risk: 'ADDITIVE', checksum: 'b28f327cd9b64365' },
  { name: '062_ledger_ingest.sql', id: 62, risk: 'ADDITIVE', checksum: 'f6c2f9d88cf3dc2d' },
  { name: '063_exchange_connections_drift.sql', id: 63, risk: 'ADDITIVE', checksum: 'a9e14194c32aa716' },
  { name: '064_equity_snapshot_bucket.sql', id: 64, risk: 'ADDITIVE', checksum: 'a54fe96523879777' },
  { name: '066_worker_project_ref.sql', id: 66, risk: 'ADDITIVE', checksum: 'a65992a340fba36c' },
  { name: '067_kill_switch_effective_mode.sql', id: 67, risk: 'ADDITIVE', checksum: '03b63727a34c35fb' },
  { name: '068_ladder_trade_connection.sql', id: 68, risk: 'ADDITIVE', checksum: '10432ab0fcf111c7' },
  { name: '069_schedule_cancel.sql', id: 69, risk: 'ADDITIVE', checksum: '3a17f6e16dc1b6a9' },
  { name: '070_scheduled_exit_cancel.sql', id: 70, risk: 'ADDITIVE', checksum: '48f3ebe4b0e6b307' },
  { name: '071_paper_started.sql', id: 71, risk: 'ADDITIVE', checksum: '61bc231f87ef54ad' },
  { name: '072_paper_settle_atomic.sql', id: 72, risk: 'ADDITIVE', checksum: 'c5049ff9b30738a3' },
  { name: '073_worker_scheduler.sql', id: 73, risk: 'ADDITIVE', checksum: '1f7a0e153672013d' },
  { name: '074_paper_open_atomic.sql', id: 74, risk: 'ADDITIVE', checksum: '52a42e53c9a30cba' },
  { name: '075_paper_capacity_atomic.sql', id: 75, risk: 'ADDITIVE', checksum: 'a880f8e4680e2120' },
  { name: '076_jobs_queue.sql', id: 76, risk: 'ADDITIVE', checksum: 'f7ac6d3d9cff3005' },
  { name: '077_execution_profile.sql', id: 77, risk: 'ADDITIVE', checksum: 'a6306a2bfba996fe' },
];

/** 코드가 요구하는 마이그레이션 파일 이름 (번호 순) */
export const REQUIRED_MIGRATIONS: string[] = MIGRATION_MANIFEST.map(m => m.name);
