package resource

import (
	"encoding/json"
	"errors"
	"net/http"
)

var ErrInvalidCloudAccount = errors.New("INVALID_CLOUD_ACCOUNT")

type CreateRequest struct {
	Name           string  `json:"name"`
	CloudAccountID string  `json:"cloud_account_id"`
	Region         *string `json:"region"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var req CreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED")
		return
	}
	if req.CloudAccountID == "" {
		writeError(w, http.StatusBadRequest, ErrInvalidCloudAccount.Error())
		return
	}
	h.create(w, r.Context(), req)
}
