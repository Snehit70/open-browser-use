package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestHeliumBridgedThroughChromeDirIsHelium(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Helium detection is Linux-only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	helium := filepath.Join(home, ".config/net.imput.helium")
	if err := os.MkdirAll(filepath.Join(helium, "Default"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(helium, filepath.Join(home, ".config/google-chrome")); err != nil {
		t.Fatal(err)
	}

	roots, err := supportedBrowserProfileRoots()
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0].BrowserID != "helium" || roots[0].BrowserName != "Helium" {
		t.Fatalf("want only the Helium root, got %+v", roots)
	}
	heliumInfo := connectedProfileInfo{Browser: "helium", BrowserName: "Helium"}
	for _, selector := range []string{"helium", "Helium", "chrome", "Google Chrome"} {
		if !browserSelectorMatches(selector, heliumInfo) {
			t.Errorf("selector %q should match bridged Helium", selector)
		}
	}
	manifest, err := defaultNativeHostManifestPathForBrowser("")
	if err != nil || filepath.Dir(filepath.Dir(manifest)) != helium {
		t.Fatalf("native host manifest should go in Helium's dir, got %q (%v)", manifest, err)
	}
}

func TestSeparateChromeAndHeliumStayDistinct(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Helium detection is Linux-only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, dir := range []string{".config/net.imput.helium", ".config/google-chrome"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	roots, err := supportedBrowserProfileRoots()
	if err != nil || len(roots) != 2 {
		t.Fatalf("want Helium and Chrome roots, got %+v (%v)", roots, err)
	}
	if browserSelectorMatches("chrome", connectedProfileInfo{Browser: "helium", BrowserName: "Helium"}) {
		t.Error("chrome must not select Helium when Chrome has its own directory")
	}
	root, err := browserRootForInstallSelector("helium")
	if err != nil || root.BrowserID != "helium" {
		t.Fatalf("helium selector: %+v %v", root, err)
	}
}

func TestBothDirsSymlinkedToOneTarget(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Helium detection is Linux-only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	data := filepath.Join(home, "data/helium")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".config"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, link := range []string{".config/net.imput.helium", ".config/google-chrome"} {
		if err := os.Symlink(data, filepath.Join(home, link)); err != nil {
			t.Fatal(err)
		}
	}
	roots, err := supportedBrowserProfileRoots()
	if err != nil || len(roots) != 1 || roots[0].BrowserID != "helium" {
		t.Fatalf("want one Helium root, got %+v (%v)", roots, err)
	}
	if _, err := defaultNativeHostManifestPathForBrowser(""); err != nil {
		t.Fatalf("default install path must not be ambiguous: %v", err)
	}
}

func TestDanglingChromeSymlinkKeepsBothRoots(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Helium detection is Linux-only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "gone"), filepath.Join(home, ".config/google-chrome")); err != nil {
		t.Fatal(err)
	}
	roots, err := supportedBrowserProfileRoots()
	if err != nil || len(roots) != 2 {
		t.Fatalf("want both roots kept, got %+v (%v)", roots, err)
	}
}
