// Native Messaging broker for the disposable ordinary Windows agreement test.
// Not installed or built by the production extension.
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	frameLimit = 128
	jsonLimit  = 4096
)

var (
	extensionOrigin = regexp.MustCompile(`^chrome-extension://[a-p]{32}/?$`)
	loopbackBase    = regexp.MustCompile(`^https://127[.]0[.]0[.]1:([1-9][0-9]{0,4})/?$`)
	tokenValue      = regexp.MustCompile(`^[!-~]{1,512}$`)
	versionValue    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,47}$`)
	hashValue       = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type brokerConfig struct {
	Origin           string `json:"origin"`
	BaseURL          string `json:"baseUrl"`
	DeviceID         string `json:"deviceId"`
	DeviceCredential string `json:"deviceCredential"`
	AccountToken     string `json:"accountToken"`
	HostDeviceID     string `json:"hostDeviceId"`
	Instance         string `json:"instance"`
	CAPEM            string `json:"caPem"`
}

// encoding/json alone accepts duplicate and case-insensitive field names.
func exactJSON(data []byte, dst any, keys ...string) bool {
	if len(data) > jsonLimit || !utf8.Valid(data) {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	if start, err := dec.Token(); err != nil || start != json.Delim('{') {
		return false
	}
	missing := make(map[string]bool, len(keys))
	for _, k := range keys {
		missing[k] = true
	}
	for dec.More() {
		token, err := dec.Token()
		key, _ := token.(string)
		if err != nil || !missing[key] {
			return false
		}
		delete(missing, key)
		var value json.RawMessage
		if dec.Decode(&value) != nil {
			return false
		}
	}
	if end, err := dec.Token(); err != nil || end != json.Delim('}') || len(missing) != 0 {
		return false
	}
	_, err := dec.Token()
	return err == io.EOF && json.Unmarshal(data, dst) == nil
}

func approvedOrigin(args []string, origin string) bool {
	// Chrome passes this optional Windows argument for service-worker calls.
	return (len(args) == 1 || len(args) == 2 && args[1] == "--parent-window=0") &&
		extensionOrigin.MatchString(origin) &&
		strings.TrimSuffix(args[0], "/") == strings.TrimSuffix(origin, "/")
}

func trustedFixture(cfg brokerConfig) *x509.CertPool {
	base := loopbackBase.FindStringSubmatch(cfg.BaseURL)
	if base == nil {
		return nil
	}
	if _, err := strconv.ParseUint(base[1], 10, 16); err != nil {
		return nil
	}
	for _, value := range []string{cfg.DeviceID, cfg.DeviceCredential, cfg.AccountToken, cfg.HostDeviceID, cfg.Instance} {
		if !tokenValue.MatchString(value) {
			return nil
		}
	}
	certPEM := strings.TrimSpace(cfg.CAPEM)
	block, rest := pem.Decode([]byte(certPEM))
	if !strings.HasPrefix(certPEM, "-----BEGIN CERTIFICATE-----") || block == nil ||
		block.Type != "CERTIFICATE" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return nil
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	return roots
}

func readOperation(in io.Reader) bool {
	// sendNativeMessage starts one process per request, with stdin still open
	// awaiting the reply. Reject already buffered extra data; never read or
	// execute a second operation, and never wait for EOF after a complete frame.
	reader := bufio.NewReaderSize(in, frameLimit+5)
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return false
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 || size > frameLimit {
		return false
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil || reader.Buffered() != 0 {
		return false
	}
	var msg struct {
		Operation string `json:"operation"`
	}
	return exactJSON(data, &msg, "operation") && msg.Operation == "agreement-status"
}

func boundedJSON(in io.Reader) ([]byte, bool) {
	data, err := io.ReadAll(io.LimitReader(in, jsonLimit+1))
	return data, err == nil && len(data) <= jsonLimit
}

func statusAllowed(cfg brokerConfig, roots *x509.CertPool) bool {
	// A dedicated transport uses no environment proxy, cookie jar, redirects,
	// or cached status; verification uses only the fixture-issued certificate.
	transport := &http.Transport{
		TLSClientConfig:        &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: jsonLimit,
	}
	client := &http.Client{
		Timeout:       2 * time.Second,
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimSuffix(cfg.BaseURL, "/")+"/api/agreements/status", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Cache-Control", "no-cache, no-store")
	req.Header.Set("X-Agreement-Device", cfg.DeviceCredential)
	req.Header.Set("Authorization", "Bearer "+cfg.AccountToken)
	req.Header.Set("X-Device-Id", cfg.HostDeviceID)
	req.Header.Set("X-Device-Instance", cfg.Instance)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	data, ok := boundedJSON(resp.Body)
	var status struct {
		Version         string `json:"version"`
		DeviceID        string `json:"deviceId"`
		ContentHash     string `json:"content_hash"`
		NeedsAcceptance *bool  `json:"needsAcceptance"`
	}
	return ok && exactJSON(data, &status, "version", "deviceId", "content_hash", "needsAcceptance") &&
		status.DeviceID == cfg.DeviceID && versionValue.MatchString(status.Version) &&
		hashValue.MatchString(status.ContentHash) && status.NeedsAcceptance != nil && !*status.NeedsAcceptance
}

func serveBroker(args []string, data []byte, in io.Reader, out io.Writer) {
	var cfg brokerConfig
	if !exactJSON(data, &cfg, "origin", "baseUrl", "deviceId", "deviceCredential", "accountToken",
		"hostDeviceId", "instance", "caPem") || !approvedOrigin(args, cfg.Origin) {
		return
	}
	roots := trustedFixture(cfg)
	if roots == nil || !readOperation(in) {
		return
	}
	result := `{"allowed":false}`
	if statusAllowed(cfg, roots) {
		result = `{"allowed":true}`
	}
	reply := make([]byte, 4, 4+len(result))
	binary.LittleEndian.PutUint32(reply, uint32(len(result)))
	_, _ = out.Write(append(reply, result...))
}

func main() {
	if runtime.GOOS != "windows" {
		return
	}
	deadline := time.AfterFunc(5*time.Second, func() { os.Exit(1) })
	defer deadline.Stop()
	exe, err := os.Executable()
	if err != nil {
		return
	}
	file, err := os.Open(filepath.Join(filepath.Dir(exe), "broker.json"))
	if err != nil {
		return
	}
	defer file.Close()
	if st, err := file.Stat(); err != nil || !st.Mode().IsRegular() {
		return
	}
	if data, ok := boundedJSON(file); ok {
		serveBroker(os.Args[1:], data, os.Stdin, os.Stdout)
	}
}
