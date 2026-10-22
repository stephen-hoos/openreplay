package user

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"

	"openreplay/backend/pkg/db/postgres/pool"
)

const testMCPSecret = "mcp-test-secret"

// fakePool answers the two queries Get makes for an MCP token.
type fakePool struct {
	pool.Pool
	tokenActive bool
}

type fakeRow struct {
	scan func(dest ...interface{}) error
}

func (r fakeRow) Scan(dest ...interface{}) error { return r.scan(dest...) }

func (p *fakePool) QueryRow(sql string, _ ...interface{}) pgx.Row {
	if strings.Contains(sql, "mcp_authentication_tokens") {
		return fakeRow{func(dest ...interface{}) error {
			*dest[0].(*bool) = p.tokenActive
			return nil
		}}
	}
	return fakeRow{func(dest ...interface{}) error {
		*dest[0].(*uint64) = 1
		*dest[1].(*string) = "User"
		*dest[2].(*string) = "user@openreplay.com"
		*dest[3].(*int) = 0
		*dest[4].(*bool) = true
		return nil
	}}
}

func mcpToken(t *testing.T) string {
	t.Helper()
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS512, JWTClaims{
		UserId:   1,
		TenantID: 1,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        "jti-1",
			Audience:  jwt.ClaimStrings{MCPAudience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
	}).SignedString([]byte(testMCPSecret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestMCPTokenRevocation(t *testing.T) {
	for _, c := range []struct {
		name   string
		active bool
	}{
		{"registered token is accepted", true},
		{"revoked token is rejected", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			u := New(&fakePool{tokenActive: c.active}, MCPConfig{Secret: testMCPSecret, Algorithm: "HS512"})
			got, err := u.Get(mcpToken(t), "unused", AuthToken)
			if c.active && (err != nil || got == nil) {
				t.Fatalf("expected user, got %v, %v", got, err)
			}
			if !c.active && err == nil {
				t.Fatal("expected revoked token to be rejected")
			}
		})
	}
}
