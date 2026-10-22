package user

import (
	"fmt"

	"openreplay/backend/pkg/db/postgres/pool"
)

func getUserFromDB(conn pool.Pool, userID, tenantID int, tokenType TokenType) (*User, error) {
	sql := fmt.Sprintf(`
		SELECT user_id, name, email, EXTRACT(epoch FROM %s)::BIGINT AS jwt_iat, role IN ('owner', 'admin') AS is_admin
	   	FROM public.users
	   	WHERE user_id = $1 AND deleted_at IS NULL
	   	LIMIT 1;`, tokenType)
	user := &User{TenantID: 1, AuthMethod: "jwt"}
	if err := conn.QueryRow(sql, userID).Scan(&user.ID, &user.Name, &user.Email, &user.JwtIat, &user.IsAdmin); err != nil {
		return nil, fmt.Errorf("user not found")
	}
	return user, nil
}

// mcpTokenActive reports whether an MCP token is still registered. Rows are deleted when the
// user's password changes, which revokes every MCP client of that user.
func mcpTokenActive(conn pool.Pool, userID int, jti string) bool {
	var active bool
	err := conn.QueryRow(`
		SELECT EXISTS(SELECT 1
		              FROM public.mcp_authentication_tokens
		              WHERE user_id = $1 AND jti = $2 AND generated);`, userID, jti).Scan(&active)
	return err == nil && active
}
