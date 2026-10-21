package service

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"openreplay/backend/pkg/logger"
)

// A file name the filesystem rejects used to hit log.Fatal and exit the process.
func TestWriteToDiskLongNameDoesNotExit(t *testing.T) {
	v := &ImageStorage{log: logger.New(), basePath: t.TempDir()}
	v.writeToDisk(&saveTask{
		ctx:       context.Background(),
		sessionID: 1,
		name:      strings.Repeat("A", 300),
		image:     bytes.NewBufferString("frame"),
	})
}
