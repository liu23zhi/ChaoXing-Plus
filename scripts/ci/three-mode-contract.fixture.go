// Copied only into a temporary checkout of the pinned TiKuHelper controller
// tests. Use its SQLite fixtures, real auth resolvers, HTTP handlers and store.
package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/itihey/tikuAdapter/internal/entity"
	"github.com/itihey/tikuAdapter/internal/extensionlogs"
	"github.com/itihey/tikuAdapter/internal/middleware"
	"github.com/itihey/tikuAdapter/internal/service"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestChaoXingThreeModeHTTP(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	db := newSearchControllerTestDB(t).Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)})
	conn, err := db.DB()
	check(err)
	t.Cleanup(func() { _ = conn.Close() })
	a := seedControllerUser(t, db, 0, "cross-client-a", "user")
	b := seedControllerUser(t, db, 0, "cross-client-b", "user")
	admin := seedControllerUser(t, db, 0, "cross-client-admin", "admin")
	const normalA, normalB = "cross-client-a-example", "cross-client-b-example"
	for user, token := range map[int32]string{a.ID: normalA, b.ID: normalB} {
		key := seedControllerTokenForUser(t, db, entity.User{ID: user}, token, 0)
		check(db.Model(&key).UpdateColumn("total_quota_limit", 5).Error)
	}
	check(db.Model(&a).Updates(map[string]any{"balance": 100, "phone": "13800000000", "wechat_id": "synthetic-owner"}).Error)
	// The store requires an MZ prefix; two inert bytes stay in memory, never on disk or executed.
	v, err := service.UploadScriptVersionWithDB(db, admin, "cross-client-fixture", "fixture.exe", []byte("MZ"))
	check(err)
	item, err := service.CreateUserScriptWithDB(db, a, service.CreateUserScriptInput{Name: "diagnostics", BaseDomain: "fixture.invalid", VersionID: v.ID})
	check(err)
	exchange, err := service.IssueScriptExchangeTokenWithDB(db, a, item.ID, 0)
	check(err)
	ticket, err := service.ExchangeScriptTokenWithDB(db, item.ShortCode, exchange.Token)
	check(err)
	identity := strings.Repeat("ab", 32)
	lease, err := service.ActivateLeasedScriptRunSessionWithDB(db, item.ShortCode, ticket.ActivationToken, identity, "127.0.0.1", 5)
	check(err)
	const device = "contract-owned-device"
	check(db.AutoMigrate(&entity.AccountDeviceBinding{}))
	check(db.Create(&entity.AccountDeviceBinding{UserID: a.ID, DeviceID: device}).Error)
	// Diagnostics are allowed to write JSONL, not to register/consume/refresh/bill.
	snapshot := func() [32]byte {
		t.Helper()
		state := map[string]any{}
		for _, table := range []string{"users", "access_tokens", "user_scripts", "script_exchange_tokens", "script_run_sessions", "account_device_bindings", "billing_records"} {
			var rows []map[string]any
			check(db.Table(table).Order("id").Find(&rows).Error)
			state[table] = rows
		}
		raw, err := json.Marshal(state)
		check(err)
		return sha256.Sum256(raw)
	}
	before := snapshot()
	dir := t.TempDir()
	oldDB, oldFiles := diagnosticDB, extensionLogFiles
	diagnosticDB, extensionLogFiles = func() *gorm.DB { return db }, extensionlogs.New(dir)
	t.Cleanup(func() { diagnosticDB, extensionLogFiles = oldDB, oldFiles })
	r := gin.New()
	check(r.SetTrustedProxies(nil))
	api := r.Group("/api/extension-logs")
	api.GET("/policy", GetExtensionIngestPolicy)
	api.POST("/start", middleware.BodyLimit(4096), StartExtensionLogs)
	api.POST("", middleware.BodyLimit(64<<10), UploadExtensionLogs)
	server := httptest.NewServer(r)
	defer server.Close()
	input, err := json.Marshal(map[string]any{"origin": server.URL, "dir": dir, "device": device,
		"ownerA": a.ID, "ownerB": b.ID, "normalA": normalA, "normalB": normalB,
		"lease": lease.Token, "identity": identity, "expiresAt": lease.ExpiresAt})
	check(err)

	client := os.Getenv("CX_CONTRACT_CLIENT")
	driver := filepath.Join(client, "scripts/ci/three-mode-contract.senders.mjs")
	args := []string{"--permission", "--allow-fs-read=" + dir}
	for _, name := range []string{"package.json", "scripts/ci/three-mode-contract.senders.mjs", "src/extension-diagnostics.js",
		"windows/node-source/extension-diagnostics.mjs", "windows/node-source/extension-log-core.mjs"} {
		args = append(args, "--allow-fs-read="+filepath.Join(client, name))
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Getenv("CX_CONTRACT_NODE"), append(args, driver)...)
	cmd.Dir, cmd.Env, cmd.Stdin = t.TempDir(), []string{"TZ=UTC"}, bytes.NewReader(input)
	output, err := cmd.CombinedOutput()
	// Never include even one-use synthetic grants in CI failure messages.
	safe := strings.NewReplacer(normalA, "[key]", normalB, "[key]", lease.Token, "[lease]", identity, "[binding]")
	if err != nil {
		t.Fatalf("first-party sender: %v\n%s", err, safe.Replace(string(output)))
	}
	t.Log(safe.Replace(strings.TrimSpace(string(output))))
	if snapshot() != before {
		t.Fatal("diagnostics mutated accounts, tokens, scripts, exchanges, leases, device bindings or billing")
	}
	t.Log("CONTRACT: all seven SQLite tables unchanged after diagnostic traffic")

	// The diagnostic handler never writes quota. Exercise the separate real
	// host-report service using the three browsers open in this bounded fixture,
	// then all closed. Historical log rows are not a live session census.
	page, err := extensionLogFiles.Read("", 100, extensionlogs.Filter{UserID: a.ID, Mode: "native_browser", DeviceID: device})
	check(err)
	browsers := map[string]bool{}
	for _, row := range page.Entries {
		browsers[row.BrowserID] = true
	}
	if len(browsers) != 3 || browsers[""] || len(page.Entries) != 6 {
		t.Fatal("expected three distinct browser scopes and six stored browser records")
	}
	for _, step := range []struct{ reported, occupied int }{{len(browsers), 3}, {0, 1}} {
		check(service.ReportDeviceSessionCount(db, a.ID, device, step.reported, time.Now()))
		used, err := service.CountDevices(db, a.ID)
		check(err)
		if used != step.occupied {
			t.Fatalf("reported %d, occupied %d (expected %d)", step.reported, used, step.occupied)
		}
	}
	t.Log("CONTRACT: same fixture host reported three then zero sessions; occupied slots 3 then 1")
}
