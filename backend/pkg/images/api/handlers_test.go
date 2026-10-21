package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	config "openreplay/backend/internal/config/images"
	"openreplay/backend/pkg/logger"
	"openreplay/backend/pkg/sessions"
	"openreplay/backend/pkg/token"
)

const testSecret = "test-secret"

type fakeResponser struct{ code int }

func (f *fakeResponser) ResponseOK(_ logger.Logger, _ context.Context, w http.ResponseWriter, _ time.Time, _ string, _ int) {
	f.code = http.StatusOK
	w.WriteHeader(http.StatusOK)
}

func (f *fakeResponser) ResponseWithJSON(_ logger.Logger, _ context.Context, w http.ResponseWriter, _ interface{}, _ time.Time, _ string, _ int) {
	f.code = http.StatusOK
	w.WriteHeader(http.StatusOK)
}

func (f *fakeResponser) ResponseWithError(_ logger.Logger, _ context.Context, w http.ResponseWriter, code int, _ error, _ time.Time, _ string, _ int) {
	f.code = code
	w.WriteHeader(code)
}

type fakeProducer struct{ produced [][]byte }

func (p *fakeProducer) Produce(_ string, _ uint64, value []byte) error {
	p.produced = append(p.produced, value)
	return nil
}
func (p *fakeProducer) ProduceToPartition(_ string, _, _ uint64, _ []byte) error { return nil }
func (p *fakeProducer) Ping(context.Context) error                               { return nil }
func (p *fakeProducer) Flush(int)                                                {}
func (p *fakeProducer) Close(int)                                                {}

type fakeSessions struct{ sessions.Sessions }

func (fakeSessions) Get(uint64) (*sessions.Session, error) { return nil, errors.New("not found") }

type fakeRegistry struct{}

func (fakeRegistry) Register(uint64, bool, int64) {}
func (fakeRegistry) Done(uint64)                  {}

const testMessageSizeLimit = 1 << 20

func newTestHandlers() (*handlersImpl, *fakeResponser, *fakeProducer) {
	cfg := &config.Config{}
	cfg.MessageSizeLimit = testMessageSizeLimit
	cfg.FileSizeLimit = 10_000_000
	resp, prod := &fakeResponser{}, &fakeProducer{}
	return &handlersImpl{
		log:        logger.New(),
		cfg:        cfg,
		responser:  resp,
		tokenizer:  token.NewTokenizer(testSecret),
		sessions:   fakeSessions{},
		producer:   prod,
		cleanupReg: fakeRegistry{},
	}, resp, prod
}

func gzipped(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func uploadRequest(t *testing.T, isFrames bool, payload []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if isFrames {
		if err := mw.WriteField("type", "frames"); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", "upload.gz")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/mobile/images", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	tok := token.NewTokenizer(testSecret).Compose(token.TokenData{ID: 1, ExpTime: time.Now().Add(time.Hour).UnixMilli()})
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

func TestMobileImagesFramesWithinLimit(t *testing.T) {
	h, resp, prod := newTestHandlers()
	req := uploadRequest(t, true, gzipped(t, bytes.Repeat([]byte{1}, 1000)))
	h.imagesUploaderHandlerMobile(httptest.NewRecorder(), req)
	if resp.code != http.StatusOK || len(prod.produced) != 1 {
		t.Fatalf("expected 200 and one produced message, got %d and %d", resp.code, len(prod.produced))
	}
}

func TestMobileImagesFramesGzipBombRejected(t *testing.T) {
	h, resp, prod := newTestHandlers()
	// 64 MB of zeros compresses to well under the 10 MB request limit.
	req := uploadRequest(t, true, gzipped(t, make([]byte, 64<<20)))
	h.imagesUploaderHandlerMobile(httptest.NewRecorder(), req)
	if resp.code != http.StatusRequestEntityTooLarge || len(prod.produced) != 0 {
		t.Fatalf("expected 413 and nothing produced, got %d and %d", resp.code, len(prod.produced))
	}
}

func TestMobileImagesTarOversizedEntryRejected(t *testing.T) {
	h, resp, prod := newTestHandlers()
	var tarBuf bytes.Buffer
	tw := tar.NewWriter(&tarBuf)
	big := make([]byte, 2*testMessageSizeLimit)
	if err := tw.WriteHeader(&tar.Header{Name: "screen_1.jpeg", Mode: 0644, Size: int64(len(big)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(big); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	req := uploadRequest(t, false, gzipped(t, tarBuf.Bytes()))
	h.imagesUploaderHandlerMobile(httptest.NewRecorder(), req)
	if resp.code != http.StatusRequestEntityTooLarge || len(prod.produced) != 0 {
		t.Fatalf("expected 413 and nothing produced, got %d and %d", resp.code, len(prod.produced))
	}
}

func TestMobileImagesTarWithinLimit(t *testing.T) {
	h, resp, prod := newTestHandlers()
	var tarBuf bytes.Buffer
	tw := tar.NewWriter(&tarBuf)
	img := bytes.Repeat([]byte{7}, 500)
	for _, name := range []string{"screen_1.jpeg", "screen_2.jpeg"} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: int64(len(img)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(img); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	req := uploadRequest(t, false, gzipped(t, tarBuf.Bytes()))
	h.imagesUploaderHandlerMobile(httptest.NewRecorder(), req)
	if resp.code != http.StatusOK || len(prod.produced) != 1 {
		t.Fatalf("expected 200 and one produced message, got %d and %d", resp.code, len(prod.produced))
	}
}
