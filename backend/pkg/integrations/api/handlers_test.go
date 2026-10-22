package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"

	"openreplay/backend/pkg/integrations/service"
	"openreplay/backend/pkg/logger"
	"openreplay/backend/pkg/server/user"
)

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

// fakeService records whether a handler got past the role check.
type fakeService struct {
	service.Service
	called bool
}

func (s *fakeService) GetIntegration(uint64, string) (interface{}, error) {
	s.called = true
	return map[string]string{}, nil
}

func (s *fakeService) DeleteIntegration(uint64, string) error {
	s.called = true
	return nil
}

func request(method string, u *user.User) *http.Request {
	r := httptest.NewRequest(method, "/1/integration/datadog", nil)
	r = mux.SetURLVars(r, map[string]string{"project": "1", "name": "datadog"})
	return r.WithContext(context.WithValue(r.Context(), "userData", u))
}

func TestIntegrationSettingsRequireAdmin(t *testing.T) {
	for _, c := range []struct {
		name    string
		isAdmin bool
		allowed bool
	}{
		{"member", false, false},
		{"admin", true, true},
	} {
		for _, method := range []string{http.MethodGet, http.MethodDelete} {
			t.Run(c.name+" "+method, func(t *testing.T) {
				resp, svc := &fakeResponser{}, &fakeService{}
				h := &handlersImpl{log: logger.New(), responser: resp, integrations: svc}
				r := request(method, &user.User{ID: 1, IsAdmin: c.isAdmin})
				if method == http.MethodGet {
					h.getIntegration(httptest.NewRecorder(), r)
				} else {
					h.deleteIntegration(httptest.NewRecorder(), r)
				}
				if svc.called != c.allowed {
					t.Fatalf("service called=%v, want %v (status %d)", svc.called, c.allowed, resp.code)
				}
				if !c.allowed && resp.code != http.StatusForbidden {
					t.Fatalf("expected 403, got %d", resp.code)
				}
			})
		}
	}
}
