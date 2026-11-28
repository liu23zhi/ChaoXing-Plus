// This source is copied into a pinned, disposable TiKuHelper checkout only
// by the ordinary-Windows test job. It is never deployed or installed.
package controller

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/itihey/tikuAdapter/internal/entity"
	"github.com/itihey/tikuAdapter/internal/registry"
	"github.com/itihey/tikuAdapter/internal/service"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestOwnedOrdinaryWindowsAgreementProvider(t *testing.T) {
	dir := os.Getenv("CX_T04_FIXTURE_DIR")
	if !filepath.IsAbs(dir) {
		t.Fatal("an absolute disposable T04 fixture directory is required")
	}
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	conn.SetMaxOpenConns(1)
	defer conn.Close()
	if err := registry.EnsureAgreementSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&entity.User{}, &entity.AccessToken{}, &entity.UserBan{}, &entity.AccountDeviceBinding{}); err != nil {
		t.Fatal(err)
	}

	token := ownedT04Random(t)
	control := ownedT04Random(t)
	owner := entity.User{Username: "owned-t04-fixture", Role: "user", Status: "enabled", RegisterSource: "legacy"}
	if err := db.Create(&owner).Error; err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(token))
	record := entity.AccessToken{UserID: owner.ID, Name: "Owned T04 synthetic", TokenHash: hex.EncodeToString(sum[:]), Status: "enabled", TotalQuotaLimit: 20}
	if err := db.Create(&record).Error; err != nil {
		t.Fatal(err)
	}

	store := service.AgreementStore{DB: db}
	publish := func(version string) error {
		row, err := store.SaveDraft(0, 0, entity.AgreementContent{Version: version, Summary: "Owned T04 fixture only", Body: "Synthetic ordinary agreement: " + version})
		if err != nil {
			return err
		}
		_, err = store.Publish(row.ID, row.Revision)
		return err
	}
	const first = "owned-t04-v1"
	const second = "owned-t04-v2"
	if err := publish(first); err != nil {
		t.Fatal(err)
	}

	oldDB, oldBudget := agreementDB, enrollmentBudget
	agreementDB = func() *gorm.DB { return db }
	enrollmentBudget = newAgreementEnrollmentBudget()
	defer func() { agreementDB, enrollmentBudget = oldDB, oldBudget }()

	gin.SetMode(gin.TestMode)
	engine := gin.New() // Never log headers or request bodies.
	if err := engine.SetTrustedProxies(nil); err != nil {
		t.Fatal(err)
	}
	group := engine.Group("/api/agreements")
	group.POST("/devices", EnrollAgreementDevice)
	group.GET("/current", CurrentAgreement)
	group.GET("/status", AgreementDeviceStatus)
	group.POST("/consents", SubmitAgreement)
	const hostID = "8246ae46-cd84-4d61-8d41-6c7be35fc292"
	const instance = "95a86154-17a4-4756-81e2-b1246b72465c"
	version := first
	var stateMu sync.Mutex
	var deviceID, credential string
	engine.POST("/__owned_t04", func(c *gin.Context) {
		if subtle.ConstantTimeCompare([]byte(control), []byte(c.GetHeader("X-Owned-Control"))) != 1 {
			c.Status(http.StatusForbidden)
			return
		}
		var x struct {
			Action string `json:"action"`
		}
		d := json.NewDecoder(io.LimitReader(c.Request.Body, 96))
		d.DisallowUnknownFields()
		var extra any
		if d.Decode(&x) != nil || d.Decode(&extra) != io.EOF {
			c.Status(http.StatusBadRequest)
			return
		}
		stateMu.Lock()
		defer stateMu.Unlock()
		if deviceID == "" || credential == "" {
			c.Status(http.StatusServiceUnavailable)
			return
		}
		var err error
		switch x.Action {
		case "accept":
			_, err = store.Accept(service.AgreementCredentials{Secret: credential, Authorization: "Bearer " + token, IP: "127.0.0.1"}, version)
		case "rotate":
			if version != first {
				c.Status(http.StatusConflict)
				return
			}
			err = publish(second)
			if err == nil {
				version = second
			}
		default:
			c.Status(http.StatusBadRequest)
			return
		}
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Status(http.StatusNoContent)
	})

	cert, ca := ownedT04LoopbackTLS(t)
	server := httptest.NewUnstartedServer(engine)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}
	server.StartTLS()
	defer server.Close()
	if !strings.HasPrefix(server.URL, "https://127.0.0.1:") {
		t.Fatal("owned authority listener was not IPv4 loopback")
	}
	client := server.Client()
	client.Timeout = 3 * time.Second
	call := func(method, path, content string, seed bool, want int, out any) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, bytes.NewBufferString(content))
		if err != nil {
			t.Fatal("fixture request construction failed")
		}
		if seed {
			req.Header.Set("X-Agreement-Device", credential)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("X-Device-Id", hostID)
			req.Header.Set("X-Device-Instance", instance)
		}
		r, err := client.Do(req)
		if err != nil {
			t.Fatal("owned provider request failed")
		}
		defer r.Body.Close()
		if r.StatusCode != want {
			t.Fatalf("fixture %s %s returned %d not %d", method, path, r.StatusCode, want)
		}
		if out != nil && json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(out) != nil {
			t.Fatal("invalid owned provider response")
		}
	}
	var enrollment struct {
		DeviceID         string
		DeviceCredential string
	}
	call("POST", "/api/agreements/devices", "", false, http.StatusCreated, &enrollment)
	stateMu.Lock()
	deviceID, credential = enrollment.DeviceID, enrollment.DeviceCredential
	stateMu.Unlock()
	if deviceID == "" || credential == "" || deviceID == hostID {
		t.Fatal("no independent synthetic agreement subject")
	}
	var status service.AgreementStatus
	call("GET", "/api/agreements/status", "", true, http.StatusOK, &status)
	if status.DeviceID != deviceID || status.Version != first || !status.NeedsAcceptance {
		t.Fatal("fresh owned subject did not start pending")
	}

	info, err := json.Marshal(map[string]string{
		"baseUrl": server.URL, "controlKey": control, "deviceId": deviceID, "deviceCredential": credential,
		"accountToken": token, "hostDeviceId": hostID, "instance": instance, "caPem": ca,
	})
	if err != nil {
		t.Fatal("cannot serialize fixture configuration")
	}
	file := filepath.Join(dir, "provider.json")
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("refuse to overwrite an existing fixture")
	}
	temp, err := os.CreateTemp(dir, "t04-info-*")
	if err != nil {
		t.Fatal("cannot create private fixture file")
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(info); err != nil {
		temp.Close()
		t.Fatal("cannot write fixture file")
	}
	if err = temp.Close(); err != nil {
		t.Fatal("cannot close fixture file")
	}
	if err = os.Rename(temp.Name(), file); err != nil {
		t.Fatal("cannot publish fixture readiness")
	}
	defer os.Remove(file)
	t.Log("owned TiKuHelper agreement handlers ready; TLS on local loopback, synthetic subject pending")
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal("fixture shutdown pipe failed")
	}
	var bindings int64
	if err := db.Model(&entity.AccountDeviceBinding{}).Count(&bindings).Error; err != nil || bindings != 0 {
		t.Fatal("agreement fixture modified business device state")
	}
	t.Log("owned fixture ended; business bindings=0")
}

func ownedT04Random(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal("fixture randomness failed")
	}
	return hex.EncodeToString(b)
}

func ownedT04LoopbackTLS(t *testing.T) (tls.Certificate, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal("test TLS key failed")
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}, IsCA: true, BasicConstraintsValid: true,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	cert, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(fmt.Sprintf("test TLS certificate failed: %v", err))
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})
	return tls.Certificate{Certificate: [][]byte{cert}, PrivateKey: key}, string(pemBytes)
}
