package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
	testDevice = "ordinary-fixture-device"
	testProof  = "synthetic-agreement-proof"
	testToken  = "synthetic-account-token"
	testHost   = "ordinary-fixture-host"
	testInst   = "synthetic-installation"
	testOp     = "{\"operation\":\"agreement-status\"}"
	testHash   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func brokerFrame(data string) []byte {
	b := make([]byte, 4, 4+len(data))
	binary.LittleEndian.PutUint32(b, uint32(len(data)))
	return append(b, data...)
}

func brokerTestServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, string) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))
}

func brokerTestConfig(base, ca string) []byte {
	out, _ := json.Marshal(map[string]string{
		"origin": testOrigin + "/", "baseUrl": base, "caPem": ca,
		"deviceId": testDevice, "deviceCredential": testProof, "accountToken": testToken,
		"hostDeviceId": testHost, "instance": testInst,
	})
	return out
}

func checkBrokerOutput(t *testing.T, config []byte, args []string, input []byte, want []byte) {
	t.Helper()
	var out bytes.Buffer
	serveBroker(args, config, bytes.NewReader(input), &out)
	if !bytes.Equal(out.Bytes(), want) {
		t.Errorf("native output differs from the expected frame/quiet failure (got %d bytes, want %d)", out.Len(), len(want))
	}
}

func TestBrokerChecksFreshAuthoritativeStatus(t *testing.T) {
	accepted := fmt.Sprintf("{\"deviceId\":%q,\"version\":\"fixture.1\",\"content_hash\":%q,\"needsAcceptance\":false}", testDevice, testHash)
	cases := []struct {
		name, body string
		status     int
		allowed    bool
	}{
		{"accepted", accepted, 200, true},
		{"published replacement still pending", strings.NewReplacer("fixture.1", "fixture.2", "false", "true").Replace(accepted), 200, false},
		{"rotated device", strings.Replace(accepted, testDevice, "rotated-device", 1), 200, false},
		{"invalid version", strings.Replace(accepted, "fixture.1", "INVALID", 1), 200, false},
		{"invalid content hash", strings.Replace(accepted, testHash, "not-a-sha", 1), 200, false},
		{"missing status", strings.Replace(accepted, ",\"needsAcceptance\":false", "", 1), 200, false},
		{"null status", strings.Replace(accepted, "false", "null", 1), 200, false},
		{"wrong status key case", strings.Replace(accepted, "needsAcceptance", "NeedsAcceptance", 1), 200, false},
		{"duplicate status", strings.Replace(accepted, "false", "true,\"needsAcceptance\":false", 1), 200, false},
		{"malformed status", accepted + "{}", 200, false},
		{"unexpected private response data", strings.TrimSuffix(accepted, "}") + ",\"diagnostic\":\"" + testToken + "\"}", 200, false},
		{"revoked proof", accepted, 401, false},
		{"unavailable", accepted, 503, false},
	}
	var calls atomic.Int32
	server, ca := brokerTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		index := int(calls.Add(1)) - 1
		if index >= len(cases) {
			t.Error("unexpected repeat provider request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Method != http.MethodGet || r.URL.String() != "/api/agreements/status" || r.ContentLength != 0 ||
			r.Header.Get("X-Agreement-Device") != testProof || r.Header.Get("Authorization") != "Bearer "+testToken ||
			r.Header.Get("X-Device-Id") != testHost || r.Header.Get("X-Device-Instance") != testInst ||
			r.Header.Get("Cookie") != "" || r.Header.Get("Cache-Control") != "no-cache, no-store" {
			t.Error("provider received wrong route, proof, cache settings or cookie")
		}
		http.SetCookie(w, &http.Cookie{Name: "ignored", Value: "test"})
		w.WriteHeader(cases[index].status)
		_, _ = io.WriteString(w, cases[index].body)
	})
	config := brokerTestConfig(server.URL, ca)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkBrokerOutput(t, config, []string{testOrigin, "--parent-window=0"}, brokerFrame(testOp),
				brokerFrame(fmt.Sprintf("{\"allowed\":%t}", tc.allowed)))
		})
	}
	if got := calls.Load(); got != int32(len(cases)) {
		t.Errorf("expected one fresh request per invocation, got %d", got)
	}
}

func TestBrokerRejectsSubstitutedOriginMalformedFrameAndReplay(t *testing.T) {
	var calls atomic.Int32
	server, ca := brokerTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	})
	config := brokerTestConfig(server.URL, ca)
	valid := brokerFrame(testOp)
	for name, input := range map[string][]byte{
		"missing": nil, "short header": valid[:3], "truncated": valid[:len(valid)-1],
		"empty": brokerFrame(""), "oversize": brokerFrame(strings.Repeat(" ", 129)),
		"invalid UTF-8":         brokerFrame(testOp[:len(testOp)-1] + "\xff}"),
		"wrong operation":       brokerFrame("{\"operation\":\"publish\"}"),
		"wrong key case":        brokerFrame("{\"Operation\":\"agreement-status\"}"),
		"duplicate key":         brokerFrame("{\"operation\":\"agreement-status\",\"operation\":\"agreement-status\"}"),
		"caller supplied input": brokerFrame("{\"operation\":\"agreement-status\",\"deviceId\":\"other\"}"),
		"extra JSON":            brokerFrame(testOp + "{}"),
		"extra byte":            append(bytes.Clone(valid), 0),
		"replay":                append(bytes.Clone(valid), valid...),
	} {
		t.Run(name, func(t *testing.T) { checkBrokerOutput(t, config, []string{testOrigin + "/"}, input, nil) })
	}
	for _, args := range [][]string{
		nil, {"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"}, {testOrigin + "/extra"},
		{testOrigin + "//"}, {testOrigin, "--parent-window=invalid"}, {testOrigin, "--parent-window=0", "--other"},
	} {
		checkBrokerOutput(t, config, args, valid, nil)
	}
	for _, variant := range [][]byte{
		bytes.Replace(config, []byte("\"origin\":"), []byte("\"Origin\":"), 1),
		bytes.Replace(config, []byte("\"origin\":"), []byte("\"origin\":\"duplicate\",\"origin\":"), 1),
		append(bytes.Clone(config), []byte("{}")...),
		bytes.Replace(config, []byte("\"origin\":"), []byte("\"extra\":null,\"origin\":"), 1),
		bytes.Replace(config, []byte("\""+testProof+"\""), []byte("null"), 1),
	} {
		checkBrokerOutput(t, variant, []string{testOrigin}, valid, nil)
	}
	if calls.Load() != 0 {
		t.Error("invalid broker input reached the provider")
	}
}

func TestBrokerLoopbackTLSAndRedirectPolicy(t *testing.T) {
	var follow atomic.Int32
	endpoint, ca := brokerTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		follow.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	})
	redirect, redirectCA := brokerTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", endpoint.URL+"/should-not-follow")
		w.WriteHeader(http.StatusTemporaryRedirect)
	})
	args, frame := []string{testOrigin}, brokerFrame(testOp)
	for _, base := range []string{
		strings.Replace(endpoint.URL, "https:", "http:", 1),
		"https://127.0.0.1", "https://127.0.0.2:443", "https://localhost:443", "https://[::1]:443",
		"https://127.0.0.1:65536", "https://127.0.0.1:0", endpoint.URL + "/a", endpoint.URL + "?",
		endpoint.URL + "#", strings.Replace(endpoint.URL, "://", "://u@", 1),
	} {
		checkBrokerOutput(t, brokerTestConfig(base, ca), args, frame, nil)
	}
	checkBrokerOutput(t, brokerTestConfig(redirect.URL+"/", redirectCA), args, frame, brokerFrame("{\"allowed\":false}"))

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	raw, err := x509.CreateCertificate(rand.Reader, cert, cert, pub, priv)
	if err != nil {
		t.Fatal(err)
	}
	wrongCA := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}))
	checkBrokerOutput(t, brokerTestConfig(endpoint.URL, wrongCA), args, frame, brokerFrame("{\"allowed\":false}"))
	if follow.Load() != 0 {
		t.Error("disallowed URL, redirect target or untrusted peer received a request")
	}
}

func TestBrokerRespondsWhileChromeKeepsStdinOpen(t *testing.T) {
	server, ca := brokerTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	input, send := io.Pipe()
	defer input.Close()
	defer send.Close()
	var out bytes.Buffer
	done := make(chan struct{})
	config := brokerTestConfig(server.URL, ca)
	go func() {
		defer close(done)
		serveBroker([]string{testOrigin, "--parent-window=0"}, config, input, &out)
	}()
	if _, err := send.Write(brokerFrame(testOp)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		if !bytes.Equal(out.Bytes(), brokerFrame("{\"allowed\":false}")) {
			t.Error("expected exactly one boolean reply with stdin still open")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("broker blocked while waiting for an EOF Chrome does not send")
	}
}
