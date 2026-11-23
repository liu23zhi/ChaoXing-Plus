// This first-party fixture is copied into an isolated, pinned TiKuHelper
// checkout. It exercises the real exchange HTTP handler and validates the
// embedded activation ticket against the real lease service before handing
// the resulting PS1 to the Windows native consumer contract.
package controller

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/itihey/tikuAdapter/internal/entity"
	"github.com/itihey/tikuAdapter/internal/service"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestChaoXingGeneratedPS1Contract(t *testing.T) {
	dir := os.Getenv("CX_TIKU_LAUNCHER_OUTPUT")
	if dir == "" {
		t.Fatal("CX_TIKU_LAUNCHER_OUTPUT is required")
	}
	for _, mode := range []string{"legacy", "escrow"} {
		t.Run(mode, func(t *testing.T) {
			check := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			db := newSearchControllerTestDB(t).Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)})
			check(db.AutoMigrate(&entity.IdempotencyRecord{}, &entity.ScriptEscrow{}, &entity.ScriptEscrowEntry{}, &entity.ScriptEscrowWork{}, &entity.ScriptActivationEntitlement{}))
			owner := seedControllerUser(t, db, 0, "ps1-owner", "user")
			admin := seedControllerUser(t, db, 0, "ps1-admin", "admin")
			check(db.Model(&owner).Updates(map[string]any{"balance": 250, "phone": "13800000000", "wechat_id": "synthetic-owner"}).Error)
			version, err := service.UploadScriptVersionWithDB(db, admin, "ps1-fixture", "fixture.exe", []byte("MZinert-fixture"), true)
			check(err)
			_, err = service.UpdateScriptDomainSettingsWithDB(db, service.ScriptDomainSettings{Domains: []string{"*.fixture.invalid", "fixture.invalid/*"}})
			check(err)
			format := "*.fixture.invalid"
			if mode == "escrow" {
				format = "fixture.invalid/*"
			}
			input := service.CreateUserScriptInput{Name: "ps1-fixture", VersionID: version.ID,
				DomainFormat: format, LauncherOrigin: &service.ScriptLauncherOrigin{Host: "fixture.invalid", HTTPS: true},
				Parameters: map[string]any{"common.settings.answer-threads": 2}}
			if mode == "escrow" {
				input.BillingMode = entity.ScriptBillingModeEscrow
			}
			item, err := service.CreateUserScriptWithDB(db, owner, input)
			check(err)
			grant, err := service.IssueScriptExchangeTokenWithDB(db, owner, item.ID, 0)
			check(err)
			previous := scriptDB
			scriptDB = func() *gorm.DB { return db }
			defer func() { scriptDB = previous }()
			router := gin.New()
			router.GET("/api/script-command/:shortCode/exchange-script", ScriptExchangeScript)
			req := httptest.NewRequest(http.MethodGet, "/api/script-command/"+item.ShortCode+"/exchange-script", nil)
			req.Header.Set("X-Script-Token", grant.Token)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("exchange handler returned HTTP %d: %s", rec.Code, rec.Body.String())
			}
			ps1 := rec.Body.String()
			match := regexp.MustCompile(`\$env:CXPLUS_SCRIPT_BOOTSTRAP_B64='([A-Za-z0-9+/=]+)'`).FindStringSubmatch(ps1)
			if len(match) != 2 {
				t.Fatal("real PS1 did not hand its bootstrap to the native child environment")
			}
			raw, err := base64.StdEncoding.DecodeString(match[1])
			check(err)
			var config struct {
				Settings map[string]any `json:"settings"`
			}
			check(json.Unmarshal(raw, &config))
			activation, _ := config.Settings["common.settings.tiku-adapter.script-activation-token"].(string)
			origin, _ := config.Settings["common.settings.tiku-adapter.baseurl"].(string)
			sessionURL, _ := config.Settings["common.settings.tiku-adapter.script-session-url"].(string)
			if activation == "" || sessionURL != origin+"/api/script-command/"+item.ShortCode+"/activate" {
				t.Fatal("invalid bootstrap activation contract")
			}
			// The PS1's actual embedded ticket must be accepted by the real service.
			lease, err := service.ActivateLeasedScriptRunSessionWithDB(db, item.ShortCode, activation, strings.Repeat("ab", 32), "127.0.0.1", 5)
			check(err)
			if !strings.HasPrefix(lease.Token, "sr_") {
				t.Fatal("activation did not issue a script-only lease")
			}
			if strings.Contains(ps1, item.AccessKey) {
				t.Fatal("PS1 leaked the long-lived key")
			}
			expected, err := json.Marshal(map[string]any{"activation": activation, "origin": origin, "sessionURL": sessionURL,
				"command": item.Command, "commandURL": item.DownloadURL, "managed": mode == "escrow"})
			check(err)
			check(os.WriteFile(filepath.Join(dir, mode+".ps1"), []byte(ps1), 0600))
			check(os.WriteFile(filepath.Join(dir, mode+".json"), expected, 0600))
			t.Log("CONTRACT: actual exchange PS1 and valid one-use activation generated for " + mode)
		})
	}
}
