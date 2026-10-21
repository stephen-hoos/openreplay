package api

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	config "openreplay/backend/internal/config/canvases"
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

func newTestHandlers() (*handlersImpl, *fakeResponser, *fakeProducer) {
	cfg := &config.Config{}
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

func uploadRequest(t *testing.T, isFrames bool, fileName string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if isFrames {
		if err := mw.WriteField("type", "frames"); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte("data")); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/web/images", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	tok := token.NewTokenizer(testSecret).Compose(token.TokenData{ID: 1, ExpTime: time.Now().Add(time.Hour).UnixMilli()})
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

func TestWebImagesFrames(t *testing.T) {
	cases := []struct {
		name     string
		fileName string
		code     int
		produced int
	}{
		{"tracker name", "1700000000000_3.webp.frames", http.StatusOK, 1},
		{"too long", strings.Repeat("A", 300) + ".frames", http.StatusUnsupportedMediaType, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, resp, prod := newTestHandlers()
			h.imagesUploaderHandlerWeb(httptest.NewRecorder(), uploadRequest(t, true, c.fileName))
			if resp.code != c.code || len(prod.produced) != c.produced {
				t.Fatalf("expected %d and %d produced, got %d and %d", c.code, c.produced, resp.code, len(prod.produced))
			}
		})
	}
}

func TestWebImagesSnapshots(t *testing.T) {
	cases := []struct {
		name     string
		fileName string
		produced int
	}{
		{"tracker name", "1700000000000_3_1700000000123.webp", 1},
		{"too long", strings.Repeat("A", 300) + "_1.png", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, resp, prod := newTestHandlers()
			h.imagesUploaderHandlerWeb(httptest.NewRecorder(), uploadRequest(t, false, c.fileName))
			if resp.code != http.StatusOK || len(prod.produced) != c.produced {
				t.Fatalf("expected 200 and %d produced, got %d and %d", c.produced, resp.code, len(prod.produced))
			}
		})
	}
}
