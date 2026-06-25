import { supabaseClient } from './supabase.js';
console.log(supabaseClient);
const locationCoords = {
  'Jandaha': [25.7222, 85.4947],
  'Patoree': [25.5978, 85.6025],
  'Hajipur': [25.6837, 85.2237],
  'Mahua': [25.8267, 85.3908],
  'Patna': [25.5941, 85.1376],
  'Local Market': [25.7222, 85.4947]
};

const fareChart = {
  'Jandaha_Patoree': 50,
  'Jandaha_Mahua': 70,
  'Jandaha_Hajipur': 130,
  'Patoree_Hajipur': 150,
  'Jandaha_Patna': 250,
  'Patoree_Patna': 280,
  'Local_Market': 20
};

const RyzoApp = {
  state: {
    currentView: 'landing',
    userRole: null, // 'customer' or 'rider'
    session: null,
    currentUser: null, // User profile data
    activeService: 'bike', // 'bike'
    activeRide: null, // active trip object
    realtimeChannel: null, // for rider dispatch listening
    customerChannel: null, // for customer updates on active ride
    profileChannel: null, // reactive wallet listener
    aadhaarFile: null,
    licenseFile: null,
    isSignUpMode: false,
    completedRideId: null, // stores ID of ride just completed for rating
    selectedRating: 0
  },


  // Map elements and overlay layers
  maps: {
    customer: null,
    rider: null
  },
  markers: {
    customerCenter: null,
    customerPickup: null,
    customerDropoff: null,
    riderCenter: null,
    riderPickup: null,
    riderDropoff: null
  },
  polylines: {
    customer: null,
    rider: null
  },

  init() {
    this.bindEvents();
    this.checkSession();
    this.setupStarsEvents();
    this.routeTo('landing');


    // Auto-offline when closing tab or reloading
    window.addEventListener('beforeunload', () => {
      if (this.state.currentUser && this.state.currentUser.role === 'rider') {
        const url = `https://zkgzpzekxuicyherpjfi.supabase.co/rest/v1/profiles?id=eq.${this.state.currentUser.id}`;
        fetch(url, {
          method: 'PATCH',
          headers: {
            'apikey': 'sb_publishable_nRRzJAhmwzHmBR19eMhClA_TJTINbIr',
            'Authorization': 'Bearer sb_publishable_nRRzJAhmwzHmBR19eMhClA_TJTINbIr',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ rider_online: false }),
          keepalive: true
        });
      }
    });
  },


  cleanLocation(address) {
    if (!address) return '';
    return address.replace(/\s*\[[0-9.-]+,\s*[0-9.-]+\]$/, '');
  },


  // ----------------------------------------------------
  // SPA ROUTING ENGINE
  // ----------------------------------------------------
  routeTo(viewName) {
    document.querySelectorAll('[data-view]').forEach(el => el.classList.add('hidden'));
    const activeView = document.querySelector(`[data-view="${viewName}"]`);
    if (activeView) activeView.classList.remove('hidden');
    this.state.currentView = viewName;
    
    // View entry actions (Leaflet maps require containers to be visible first)
    if (viewName === 'customer') {
      this.loadCustomerDashboard();
      setTimeout(() => this.initCustomerMap(), 100);
    } else if (viewName === 'rider') {
      this.loadRiderDashboard();
      setTimeout(() => this.initRiderMap(), 100);
    } else if (viewName === 'admin') {
      this.loadAdminDashboard();
    }
  },

  switchView(viewName) {
    const rideView = document.getElementById('ride-view');
    const historyView = document.getElementById('history-view');
    const navBtnRide = document.getElementById('nav-btn-ride');
    const navBtnHistory = document.getElementById('nav-btn-history');

    if (rideView) rideView.classList.add('hidden');
    if (historyView) historyView.classList.add('hidden');

    [navBtnRide, navBtnHistory].forEach(btn => {
      if (btn) {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--text-muted)';
      }
    });

    if (viewName === 'ride') {
      if (rideView) rideView.classList.remove('hidden');
      if (navBtnRide) {
        navBtnRide.style.background = 'var(--card-charcoal)';
        navBtnRide.style.color = 'white';
      }
      if (this.maps.customer) {
        setTimeout(() => this.maps.customer.invalidateSize(), 50);
      }
    } else if (viewName === 'history') {
      if (historyView) historyView.classList.remove('hidden');
      if (navBtnHistory) {
        navBtnHistory.style.background = 'var(--card-charcoal)';
        navBtnHistory.style.color = 'white';
      }
      this.loadCustomerHistory();
    }
  },

  getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in meters
  },

  async checkVerificationRequirements() {
    const otpInput = document.getElementById('rider-otp-input');
    const verifyTripBtn = document.getElementById('rider-btn-complete-trip');
    const statusText = document.getElementById('rider-verification-status-text');

    if (!otpInput || !statusText) return;

    const enteredOtp = otpInput.value.trim();
    if (enteredOtp.length !== 4) {
      if (verifyTripBtn) verifyTripBtn.disabled = true;
      if (statusText) statusText.innerText = 'Please enter a 4-digit OTP.';
      return;
    }

    if (this.state.activeRide) {
      const storedOtp = this.state.activeRide.otp ? String(this.state.activeRide.otp).trim() : '';
      if (enteredOtp !== storedOtp) {
        if (verifyTripBtn) verifyTripBtn.disabled = true;
        if (statusText) statusText.innerText = 'Incorrect OTP code.';
        return;
      }
      if (verifyTripBtn) verifyTripBtn.disabled = false;
      const stageText = this.state.activeRide.status === 'accepted' ? 'start trip' : 'complete trip';
      if (statusText) statusText.innerText = `Verification code matches! Ready to ${stageText}.`;
    }
  },

  // ----------------------------------------------------
  // INTELLIGENT MAP INTEGRATION (LEAFLET.JS)
  // ----------------------------------------------------
  initCustomerMap() {
    const container = document.getElementById('map');
    if (!container) return;

    if (this.maps.customer) {
      this.maps.customer.invalidateSize();
      return;
    }

    // Centered at Jandaha [25.6450, 85.5410] by default
    const defaultCenter = [25.6450, 85.5410];
    this.maps.customer = L.map('map', { zoomControl: false }).setView(defaultCenter, 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(this.maps.customer);

    this.markers.customerCenter = L.marker(defaultCenter)
      .addTo(this.maps.customer)
      .bindPopup('Jandaha Hub');

    // Geo-location auto-centering
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const userLocation = [lat, lng];
          this.maps.customer.setView(userLocation, 14);
          
          if (this.markers.customerCenter) {
            this.maps.customer.removeLayer(this.markers.customerCenter);
          }
          
          this.markers.customerCenter = L.marker(userLocation)
             .addTo(this.maps.customer)
             .bindPopup('Your Current Location')
             .openPopup();
        },
        (error) => console.log('Customer Geolocation error:', error),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    }
  },

  initRiderMap() {
    const container = document.getElementById('map-rider');
    if (!container) return;

    if (this.maps.rider) {
      this.maps.rider.invalidateSize();
      return;
    }

    const defaultCenter = [25.6450, 85.5410];
    this.maps.rider = L.map('map-rider', { zoomControl: false }).setView(defaultCenter, 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(this.maps.rider);

    this.markers.riderCenter = L.marker(defaultCenter)
      .addTo(this.maps.rider)
      .bindPopup('Active Transporter Base');

    // Geo-location auto-centering
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const userLocation = [lat, lng];
          this.maps.rider.setView(userLocation, 14);
          
          if (this.markers.riderCenter) {
            this.maps.rider.removeLayer(this.markers.riderCenter);
          }
          
          this.markers.riderCenter = L.marker(userLocation)
             .addTo(this.maps.rider)
             .bindPopup('Your Location')
             .openPopup();
        },
        (error) => console.log('Rider Geolocation error:', error),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    }
  },

  // Resolves address string to coordinates using locationCoords lookup table
  // Resolves address string to coordinates using dataset, inline coordinates, or lookup table
  getCoordinates(address, inputId = null) {
    if (inputId) {
      const el = document.getElementById(inputId);
      if (el && el.dataset.lat && el.dataset.lng) {
        return [parseFloat(el.dataset.lat), parseFloat(el.dataset.lng)];
      }
    }
    if (!address) return [25.7222, 85.4947];
    const match = address.match(/\[([0-9.-]+),\s*([0-9.-]+)\]/);
    if (match) {
      return [parseFloat(match[1]), parseFloat(match[2])];
    }
    const addr = address.toLowerCase().trim();
    for (const key in locationCoords) {
      if (addr.includes(key.toLowerCase()) || key.toLowerCase().includes(addr)) {
        return locationCoords[key];
      }
    }
    return [25.7222, 85.4947];
  },


  // Draws polyline path connecting Pickup and Dropoff
  drawActiveRoute(pickupCoords, dropoffCoords, mapType) {
    const activeMap = this.maps[mapType];
    if (!activeMap) return;

    // Reset previous paths
    this.clearActiveRoute(mapType);

    // Render Crimson Polyline Route
    this.polylines[mapType] = L.polyline([pickupCoords, dropoffCoords], {
      color: '#FF003C',
      weight: 5,
      opacity: 0.85
    }).addTo(activeMap);

    // Add markers
    this.markers[mapType + 'Pickup'] = L.marker(pickupCoords)
      .addTo(activeMap)
      .bindPopup('Pickup Point')
      .openPopup();

    this.markers[mapType + 'Dropoff'] = L.marker(dropoffCoords)
      .addTo(activeMap)
      .bindPopup('Dropoff Destination');

    // Fit boundary constraints
    const group = new L.featureGroup([
      this.markers[mapType + 'Pickup'],
      this.markers[mapType + 'Dropoff']
    ]);
    activeMap.fitBounds(group.getBounds().pad(0.15));
  },

  clearActiveRoute(mapType) {
    const activeMap = this.maps[mapType];
    if (!activeMap) return;

    if (mapType === 'customer') {
      this.clearRiderMarkerOnCustomerMap();
    }

    if (this.polylines[mapType]) {
      activeMap.removeLayer(this.polylines[mapType]);
      this.polylines[mapType] = null;
    }
    if (this.markers[mapType + 'Pickup']) {
      activeMap.removeLayer(this.markers[mapType + 'Pickup']);
      this.markers[mapType + 'Pickup'] = null;
    }
    if (this.markers[mapType + 'Dropoff']) {
      activeMap.removeLayer(this.markers[mapType + 'Dropoff']);
      this.markers[mapType + 'Dropoff'] = null;
    }

    activeMap.setView([25.6450, 85.5410], 13); // Centered at Jandaha Hub
  },

  updateRiderMarkerOnCustomerMap(lat, lng) {
    if (!this.maps.customer) return;

    const position = [lat, lng];
    if (this.markers.liveRider) {
      this.markers.liveRider.setLatLng(position);
    } else {
      const bikeIcon = L.divIcon({
        className: 'bike-icon-marker',
        html: `<div style="background:var(--accent-cyan); border:2px solid white; border-radius:50%; width:20px; height:20px; box-shadow: 0 0 10px var(--accent-cyan);"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      
      this.markers.liveRider = L.marker(position, { icon: bikeIcon })
        .addTo(this.maps.customer)
        .bindPopup('Your Rider')
        .openPopup();
    }
  },

  clearRiderMarkerOnCustomerMap() {
    if (this.markers.liveRider && this.maps.customer) {
      this.maps.customer.removeLayer(this.markers.liveRider);
      this.markers.liveRider = null;
    }
  },

  // ----------------------------------------------------
  // EVENT BINDINGS
  // ----------------------------------------------------
  bindEvents() {
    // Landing view buttons
    const btnChooseCustomer = document.getElementById('btn-choose-customer');
    if (btnChooseCustomer) {
      btnChooseCustomer.addEventListener('click', () => {
        this.state.userRole = 'customer';
        this.state.isSignUpMode = false;
        this.toggleAuthMode(false);
        this.routeTo('auth');
      });
    }

    const btnChooseRider = document.getElementById('btn-choose-rider');
    if (btnChooseRider) {
      btnChooseRider.addEventListener('click', () => {
        this.state.userRole = 'rider';
        this.state.isSignUpMode = false;
        this.toggleAuthMode(false);
        this.routeTo('auth');
      });
    }

    // Auth back button
    const authBtnBack = document.getElementById('auth-btn-back');
    if (authBtnBack) {
      authBtnBack.addEventListener('click', () => {
        this.routeTo('landing');
      });
    }

    // Auth tab switching
    const tabLogin = document.getElementById('tab-login');
    if (tabLogin) {
      tabLogin.addEventListener('click', () => {
        this.toggleAuthMode(false);
      });
    }

    const tabSignup = document.getElementById('tab-signup');
    if (tabSignup) {
      tabSignup.addEventListener('click', () => {
        this.toggleAuthMode(true);
      });
    }

    // File inputs preview and caching
    const aadhaarInput = document.getElementById('auth-aadhaar-file');
    const licenseInput = document.getElementById('auth-license-file');

    if (aadhaarInput) {
      aadhaarInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          this.state.aadhaarFile = file;
          const labelText = document.getElementById('aadhaar-label-text');
          if (labelText) labelText.innerText = `Selected: ${file.name}`;
          const preview = document.getElementById('aadhaar-preview');
          if (preview) {
            preview.src = URL.createObjectURL(file);
            preview.classList.remove('hidden');
          }
        }
      });
    }

    if (licenseInput) {
      licenseInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          this.state.licenseFile = file;
          const labelText = document.getElementById('license-label-text');
          if (labelText) labelText.innerText = `Selected: ${file.name}`;
          const preview = document.getElementById('license-preview');
          if (preview) {
            preview.src = URL.createObjectURL(file);
            preview.classList.remove('hidden');
          }
        }
      });
    }

    // Auth Submit
    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleAuthSubmit();
      });
    }

    // Logout Buttons
    const customerBtnLogout = document.getElementById('customer-btn-logout');
    if (customerBtnLogout) {
      customerBtnLogout.addEventListener('click', () => this.handleLogout());
    }
    const riderBtnLogout = document.getElementById('rider-btn-logout');
    if (riderBtnLogout) {
      riderBtnLogout.addEventListener('click', () => this.handleLogout());
    }
    const lockoutBtnLogout = document.getElementById('lockout-btn-logout');
    if (lockoutBtnLogout) {
      lockoutBtnLogout.addEventListener('click', () => this.handleLogout());
    }
    const adminBtnLogout = document.getElementById('admin-btn-logout');
    if (adminBtnLogout) {
      adminBtnLogout.addEventListener('click', () => this.handleLogout());
    }

    // Customer Service Selectors
    document.querySelectorAll('[data-service]').forEach(card => {
      card.addEventListener('click', (e) => {
        const clickedCard = e.currentTarget;
        document.querySelectorAll('[data-service]').forEach(c => c.classList.remove('active'));
        clickedCard.classList.add('active');
        
        const service = clickedCard.getAttribute('data-service');
        this.state.activeService = service;
        
        // Toggle conditional input views
        const panelDelivery = document.getElementById('panel-delivery');
        if (panelDelivery) panelDelivery.classList.add('hidden');

        if (service === 'delivery' && panelDelivery) {
          panelDelivery.classList.remove('hidden');
        }

        this.calculateFares();
      });
    });

    // Change listener bindings for pickup/dropoff select dropdowns
    const customerPickup = document.getElementById('customer-pickup');
    if (customerPickup) {
      customerPickup.addEventListener('change', () => this.calculateFares());
    }
    const customerDropoff = document.getElementById('customer-dropoff');
    if (customerDropoff) {
      customerDropoff.addEventListener('change', () => this.calculateFares());
    }

    // Customer cancellation button bindings
    const custBtnCancelRide = document.getElementById('cust-btn-cancel-ride');
    if (custBtnCancelRide) {
      custBtnCancelRide.addEventListener('click', () => this.cancelActiveRide());
    }

    // Rider dashboard task actions & withdrawal form bindings
    const riderBtnCancelTask = document.getElementById('rider-btn-cancel-task');
    if (riderBtnCancelTask) {
      riderBtnCancelTask.addEventListener('click', () => this.riderCancelTask());
    }
    const withdrawalForm = document.getElementById('rider-withdrawal-form');
    if (withdrawalForm) {
      withdrawalForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submitWithdrawalRequest();
      });
    }


    // Customer Dispatch Trigger (throttled to 1 click every 30s)
    const customerBtnDispatch = document.getElementById('customer-btn-dispatch');
    if (customerBtnDispatch) {
      const throttledDispatch = this.throttle(() => this.triggerCustomerDispatch(), 30000);
      customerBtnDispatch.addEventListener('click', throttledDispatch);
    }

    // Rider online duty switch
    const riderDutySwitch = document.getElementById('rider-duty-switch');
    if (riderDutySwitch) {
      riderDutySwitch.addEventListener('change', (e) => {
        this.handleRiderDutyToggle(e.target.checked);
      });
    }

    const riderOtpInput = document.getElementById('rider-otp-input');
    if (riderOtpInput) {
      riderOtpInput.addEventListener('input', () => this.checkVerificationRequirements());
    }

    // Complete active ride (Legacy - replaced by inline completeActiveOrder)
    const riderBtnCompleteTrip = document.getElementById('rider-btn-complete-trip');
    if (riderBtnCompleteTrip) {
      riderBtnCompleteTrip.addEventListener('click', () => this.completeActiveRide());
    }

    // Wallet replenishment simulator (overdraft page)
    const lockoutBtnReplenish = document.getElementById('lockout-btn-replenish');
    if (lockoutBtnReplenish) {
      lockoutBtnReplenish.addEventListener('click', () => {
        document.getElementById('lockout-overlay').classList.add('hidden');
        this.showLoadWalletModal();
      });
    }
    const lockoutBtnCopyUpi = document.getElementById('lockout-btn-copy-upi');
    if (lockoutBtnCopyUpi) {
      lockoutBtnCopyUpi.addEventListener('click', () => {
        navigator.clipboard.writeText('paytm.ryzo@paytm');
        this.showToast('Merchant UPI ID copied!');
      });
    }

    // Top-Up Wallet modal bindings (Rider Dashboard)
    const riderBtnTopup = document.getElementById('rider-btn-topup');
    if (riderBtnTopup) {
      riderBtnTopup.addEventListener('click', () => {
        this.showLoadWalletModal();
      });
    }

    const topupBtnClose = document.getElementById('topup-btn-close');
    if (topupBtnClose) {
      topupBtnClose.addEventListener('click', () => {
        const topupModal = document.getElementById('topup-modal');
        if (topupModal) topupModal.classList.add('hidden');
      });
    }

    const topupBtnVerify = document.getElementById('topup-btn-verify');
    if (topupBtnVerify) {
      topupBtnVerify.addEventListener('click', () => {
        this.replenishWallet();
        const topupModal = document.getElementById('topup-modal');
        if (topupModal) topupModal.classList.add('hidden');
      });
    }

    const topupBtnCopyUpi = document.getElementById('topup-btn-copy-upi');
    if (topupBtnCopyUpi) {
      topupBtnCopyUpi.addEventListener('click', () => {
        navigator.clipboard.writeText('paytm.ryzo@paytm');
        this.showToast('Merchant UPI ID copied!');
      });
    }
  },

  // ----------------------------------------------------
  // ADVANCED RIDER RATING SYSTEM (MODAL & BACKEND SYNC)
  // ----------------------------------------------------
  setupStarsEvents() {
    const stars = document.querySelectorAll('.star-svg');
    let selectedRating = 0;

    stars.forEach(star => {
      // Mouse Hover styling scale and glow (mouseover)
      star.addEventListener('mouseover', (e) => {
        const ratingVal = parseInt(e.currentTarget.getAttribute('data-rating'));
        stars.forEach(s => {
          const r = parseInt(s.getAttribute('data-rating'));
          if (r <= ratingVal) {
            s.classList.add('selected');
          } else {
            s.classList.remove('selected');
          }
        });
      });

      // Mouse Leave reset back to selectedRating
      document.getElementById('stars-container').addEventListener('mouseleave', () => {
        stars.forEach(s => {
          const r = parseInt(s.getAttribute('data-rating'));
          if (r <= selectedRating) {
            s.classList.add('selected');
          } else {
            s.classList.remove('selected');
          }
        });
      });

      // Click selected selection
      star.addEventListener('click', (e) => {
        selectedRating = parseInt(e.currentTarget.getAttribute('data-rating'));
        this.state.selectedRating = selectedRating;
        stars.forEach(s => {
          const r = parseInt(s.getAttribute('data-rating'));
          if (r <= selectedRating) {
            s.classList.add('selected');
          } else {
            s.classList.remove('selected');
          }
        });
      });
    });

    // Submit rating trigger action
    document.getElementById('btn-submit-rating').addEventListener('click', () => {
      if (!this.state.selectedRating) {
        this.showToast('Please select a star rating.');
        return;
      }
      const commentEl = document.getElementById('rating-comment');
      const comment = commentEl ? commentEl.value.trim() : '';
      
      this.submitRating(
        this.state.completedRideId,
        this.state.completedRiderId,
        this.state.selectedRating,
        comment
      );
    });
  },

  async submitRating(completedId, riderId, rating, comment) {
    this.showLoader(true);
    try {
      const insertPayload = { 
        rating: rating,
        ride_id: completedId,
        order_id: completedId,
        comment: comment,
        review_text: comment
      };

      if (riderId) {
        insertPayload.rider_id = riderId;
      }

      const { error } = await supabaseClient
        .from('ratings')
        .insert([insertPayload]);

      if (error) throw error;

      this.showToast('Feedback submitted successfully. Thank you!');
      
      // Reset Modal UI
      document.getElementById('rating-modal').classList.add('hidden');
      const commentEl = document.getElementById('rating-comment');
      if (commentEl) commentEl.value = '';
      this.state.completedRideId = null;
      this.state.completedRiderId = null;
      this.state.completedType = null;
      this.state.selectedRating = 0;
      document.querySelectorAll('.star-svg').forEach(s => s.classList.remove('selected'));

      // Refresh customer history list dynamically if active
      if (document.getElementById('history-list')) {
        this.loadCustomerHistory();
      }

    } catch (e) {
      console.error(e);
      this.showToast('Rating synchronization failed. RLS policy error or table ratings missing.');
    } finally {
      this.showLoader(false);
    }
  },

  openRatingFromHistory(rideId, riderId) {
    this.state.completedRideId = rideId;
    this.state.completedRiderId = riderId;
    this.state.completedType = 'ride';
    
    // Reset stars
    this.state.selectedRating = 0;
    document.querySelectorAll('.star-svg').forEach(s => s.classList.remove('selected'));
    const commentEl = document.getElementById('rating-comment');
    if (commentEl) commentEl.value = '';

    const ratingModal = document.getElementById('rating-modal');
    if (ratingModal) ratingModal.classList.remove('hidden');
  },

  // ----------------------------------------------------
  // AUTHENTICATION FLOWS
  // ----------------------------------------------------
  toggleAuthMode(isSignUp) {
    this.state.isSignUpMode = isSignUp;
    const tabLogin = document.getElementById('tab-login');
    const tabSignup = document.getElementById('tab-signup');
    const signupFields = document.getElementById('signup-fields');
    const riderFields = document.getElementById('rider-signup-fields');
    const submitBtnText = document.getElementById('auth-btn-text');
    const roleBadge = document.getElementById('auth-role-badge');
    
    // Style role badge
    if (roleBadge && this.state.userRole) {
      roleBadge.innerText = this.state.userRole.toUpperCase();
      roleBadge.style.color = 'var(--accent-cyan)';
    }

    if (isSignUp) {
      if (tabLogin) {
        tabLogin.style.background = 'transparent';
        tabLogin.style.color = 'var(--text-muted)';
      }
      if (tabSignup) {
        tabSignup.style.background = 'var(--card-charcoal)';
        tabSignup.style.color = 'white';
      }
      if (signupFields) signupFields.classList.remove('hidden');
      if (submitBtnText) submitBtnText.innerText = 'Create Account';

      if (this.state.userRole === 'rider') {
        if (riderFields) riderFields.classList.remove('hidden');
      } else {
        if (riderFields) riderFields.classList.add('hidden');
      }
    } else {
      if (tabSignup) {
        tabSignup.style.background = 'transparent';
        tabSignup.style.color = 'var(--text-muted)';
      }
      if (tabLogin) {
        tabLogin.style.background = 'var(--card-charcoal)';
        tabLogin.style.color = 'white';
      }
      if (signupFields) signupFields.classList.add('hidden');
      if (riderFields) riderFields.classList.add('hidden');
      if (submitBtnText) submitBtnText.innerText = 'Log In';
    }
  },

  handleVehicleTypeChange(value) {
    const regInput = document.getElementById('auth-bike-reg');
    const licInput = document.getElementById('auth-license-num');
    const licBox = document.getElementById('upload-license-box');

    const regGroup = regInput ? regInput.closest('.input-group') : null;
    const licGroup = licInput ? licInput.closest('.input-group') : null;
    const boxGroup = licBox ? licBox.closest('.input-group') : null;

    if (value === 'bicycle') {
      if (regGroup) regGroup.classList.add('hidden');
      if (licGroup) licGroup.classList.add('hidden');
      if (boxGroup) boxGroup.classList.add('hidden');
    } else {
      if (regGroup) regGroup.classList.remove('hidden');
      if (licGroup) licGroup.classList.remove('hidden');
      if (boxGroup) boxGroup.classList.remove('hidden');
    }
  },

  async handleAuthSubmit() {
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;

    this.showLoader(true);

    try {
      if (this.state.isSignUpMode) {
        const fullName = document.getElementById('auth-name').value;
        const phone = document.getElementById('auth-phone').value;

        if (!fullName || !phone) {
          throw new Error('Please fill in Name and Phone.');
        }

        if (this.state.userRole === 'rider') {
          const vehicleType = document.getElementById('auth-vehicle-type').value;
          if (vehicleType === 'motorbike') {
            if (!this.state.aadhaarFile || !this.state.licenseFile) {
              throw new Error('Motorbike riders must upload Aadhaar Card and Driving License photographs.');
            }
          } else {
            if (!this.state.aadhaarFile) {
              throw new Error('Bicycle riders must upload Aadhaar Card photograph.');
            }
          }
        }

        const { data: authData, error: authError } = await supabaseClient.auth.signUp({
          email,
          password
        });

        if (authError) throw authError;
        const user = authData.user;
        if (!user) throw new Error('Signup failed. Check email format or password strength.');

        let aadhaarUrl = null;
        let licenseUrl = null;

        if (this.state.userRole === 'rider') {
          const timestamp = Date.now();
          const vehicleType = document.getElementById('auth-vehicle-type').value;
          
          const aadhaarPath = `${user.id}/aadhaar_${timestamp}_${this.state.aadhaarFile.name}`;
          const { error: adErr } = await supabaseClient.storage
            .from('rider_documents')
            .upload(aadhaarPath, this.state.aadhaarFile);
          if (adErr) throw new Error(`Aadhaar upload failed: ${adErr.message}`);
          aadhaarUrl = supabaseClient.storage.from('rider_documents').getPublicUrl(aadhaarPath).data.publicUrl;

          if (vehicleType === 'motorbike' && this.state.licenseFile) {
            const licensePath = `${user.id}/license_${timestamp}_${this.state.licenseFile.name}`;
            const { error: licErr } = await supabaseClient.storage
              .from('rider_documents')
              .upload(licensePath, this.state.licenseFile);
            if (licErr) throw new Error(`License upload failed: ${licErr.message}`);
            licenseUrl = supabaseClient.storage.from('rider_documents').getPublicUrl(licensePath).data.publicUrl;
          }
        }

        const vehicleType = this.state.userRole === 'rider' ? document.getElementById('auth-vehicle-type').value : null;
        const profilePayload = {
          id: user.id,
          role: this.state.userRole,
          full_name: fullName,
          phone: phone,
          bike_registration: (this.state.userRole === 'rider' && vehicleType === 'motorbike') ? document.getElementById('auth-bike-reg').value : null,
          driving_license: (this.state.userRole === 'rider' && vehicleType === 'motorbike') ? document.getElementById('auth-license-num').value : null,
          aadhaar_url: aadhaarUrl,
          license_url: licenseUrl,
          is_verified: this.state.userRole === 'customer',
          wallet_balance: this.state.userRole === 'rider' ? 100.0 : 0.0,
          rider_online: false,
          vehicle_type: vehicleType
        };

        const { error: profileError } = await supabaseClient
          .from('profiles')
          .insert([profilePayload]);

        if (profileError) throw profileError;

        this.showToast('Account created! Logging in...');
        
        const { data: loginData, error: loginErr } = await supabaseClient.auth.signInWithPassword({
          email,
          password
        });
        if (loginErr) throw loginErr;
        
        await this.handleLoginSuccess(loginData.session);

      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

        if (error) throw error;
        await this.handleLoginSuccess(data.session);
      }
    } catch (err) {
      console.error(err);
      this.showToast(err.message || 'An error occurred during authentication.');
    } finally {
      this.showLoader(false);
    }
  },

  async handleLoginSuccess(session) {
    this.state.session = session;
    const user = session.user;
    
    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error || !profile) {
      await supabaseClient.auth.signOut();
      throw new Error('Your user profile could not be found. Please contact support.');
    }

    this.state.currentUser = profile;
    this.state.userRole = profile.role;

    this.showToast(`Welcome back, ${profile.full_name}!`);
    
    // Register reactive profiles database listener (Exactly public:profiles)
    this.setupProfileListener(user.id);

    if (profile.role === 'admin') {
      this.routeTo('admin');
    } else if (profile.role === 'customer') {
      this.routeTo('customer');
    } else {
      this.routeTo('rider');
    }
  },

  // Real-time user profile listener using the exact channel requested
  setupProfileListener(userId) {
    if (this.state.profileChannel) {
      supabaseClient.removeChannel(this.state.profileChannel);
    }

    this.state.profileChannel = supabaseClient
      .channel('public:profiles')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `id=eq.${userId}`
      }, (payload) => {
        console.log('Reactive profile updates synchronized:', payload.new);
        this.state.currentUser = payload.new;
        
        if (payload.new.role === 'customer') {
          const walletEl = document.getElementById('customer-wallet-balance');
          if (walletEl) walletEl.innerText = `₹${parseFloat(payload.new.wallet_balance || 0).toFixed(2)}`;
        } else if (payload.new.role === 'rider') {
          const walletEl = document.getElementById('rider-wallet-balance');
          if (walletEl) walletEl.innerText = `₹${parseFloat(payload.new.wallet_balance).toFixed(2)}`;
          
          if (parseFloat(payload.new.wallet_balance) <= 0) {
            this.triggerOverdraftLockout(payload.new.wallet_balance);
          } else {
            const lockoutOverlay = document.getElementById('lockout-overlay');
            if (lockoutOverlay) lockoutOverlay.classList.add('hidden');
            const dutySwitch = document.getElementById('rider-duty-switch');
            if (dutySwitch && dutySwitch.disabled) {
              dutySwitch.disabled = false;
              dutySwitch.checked = payload.new.rider_online;
              this.loadRiderDashboard();
            }
          }
        }
      })
      .subscribe();
  },

  async handleLogout() {
    this.showLoader(true);
    try {
      this.disconnectRiderRealtime();
      this.disconnectCustomerRideRealtime();
      this.disconnectCustomerOrderRealtime();
      this.stopRiderLocationTracking();

      if (this.state.profileChannel) {
        supabaseClient.removeChannel(this.state.profileChannel);
        this.state.profileChannel = null;
      }

      if (this.state.currentUser && this.state.currentUser.role === 'rider') {
        await supabaseClient
          .from('profiles')
          .update({ rider_online: false })
          .eq('id', this.state.currentUser.id);
      }

      await supabaseClient.auth.signOut();
      
      this.state.session = null;
      this.state.currentUser = null;
      this.state.userRole = null;
      this.state.activeRide = null;

      const lockoutOverlay = document.getElementById('lockout-overlay');
      if (lockoutOverlay) lockoutOverlay.classList.add('hidden');
      const ratingModal = document.getElementById('rating-modal');
      if (ratingModal) ratingModal.classList.add('hidden');
      const topupModal = document.getElementById('topup-modal');
      if (topupModal) topupModal.classList.add('hidden');
      
      this.showToast('Logged out successfully.');
      this.routeTo('landing');
    } catch (e) {
      this.showToast('Logout failed.');
    } finally {
      this.showLoader(false);
    }
  },

  async checkSession() {
    const { data } = await supabaseClient.auth.getSession();
    if (data.session) {
      try {
        await this.handleLoginSuccess(data.session);
      } catch (e) {
        console.log('Session restore error:', e);
      }
    }
  },

  // ----------------------------------------------------
  // CUSTOMER DASHBOARD CONTROLLER
  // ----------------------------------------------------
  loadCustomerDashboard() {
    const profileEl = document.getElementById('customer-profile-name');
    if (profileEl && this.state.currentUser) {
      profileEl.innerText = this.state.currentUser.full_name;
    }

    // Update customer wallet balance display
    const walletBalanceEl = document.getElementById('customer-wallet-balance');
    if (walletBalanceEl && this.state.currentUser) {
      walletBalanceEl.innerText = `₹${parseFloat(this.state.currentUser.wallet_balance || 0).toFixed(2)}`;
    }
    
    // Default switch view to ride so UI is fully showing something
    this.switchView('ride');

    this.checkActiveCustomerRide();
  },

  async triggerCustomerDispatch() {
    const pickupEl = document.getElementById('customer-pickup');
    const dropoffEl = document.getElementById('customer-dropoff');
    const fareTextEl = document.getElementById('fare-estimate-display');

    if (!pickupEl || !dropoffEl || !fareTextEl) return;

    const pickup = pickupEl.value.trim();
    const dropoff = dropoffEl.value.trim();
    const fareText = fareTextEl.innerText;
    const fare = parseFloat(fareText.replace('₹', ''));

    if (!pickup || !dropoff) {
      this.showToast('Please enter both pickup and dropoff locations.');
      return;
    }

    if (this.state.activeRide) {
      this.showToast('You already have an active request in dispatch.');
      return;
    }

    // Friction Layers: check wallet balance and strikes first
    const walletBalance = parseFloat(this.state.currentUser.wallet_balance || 0);
    if (walletBalance < 20) {
      this.showToast('Insufficient balance. Please load your wallet.');
      this.showLoadWalletModal();
      return;
    }
    const strikes = parseInt(this.state.currentUser.customer_strikes || 0);
    if (strikes >= 3) {
      this.showToast('Account suspended: Too many cancellations.');
      return;
    }

    if (isNaN(fare) || fare <= 0) {
      this.showToast('Selected route is not supported.');
      return;
    }

    this.showLoader(true);

    try {
      const pickupCoords = this.getCoordinates(pickup);
      const dropoffCoords = this.getCoordinates(dropoff);
      
      const dbPickup = `${pickup} [${pickupCoords[0]},${pickupCoords[1]}]`;
      const dbDropoff = `${dropoff} [${dropoffCoords[0]},${dropoffCoords[1]}]`;

      const { data, error } = await supabaseClient
        .from('orders')
        .insert([{
          user_id: this.state.currentUser.id,
          customer_id: this.state.currentUser.id,
          pickup: dbPickup,
          dropoff: dbDropoff,
          pickup_lat: pickupCoords[0],
          pickup_lng: pickupCoords[1],
          dropoff_lat: dropoffCoords[0],
          dropoff_lng: dropoffCoords[1],
          fare: fare,
          total_price: fare,
          status: 'pending',
          items: []
        }])
        .select()
        .single();

      if (error) throw error;

      this.state.activeRide = data;
      this.showToast('Ride requested successfully!');
      this.renderCustomerRideOverlay(data);
      this.listenToCustomerRideUpdates(data.id);

    } catch (e) {
      console.error(e);
      this.showToast('Failed to create dispatch request.');
    } finally {
      this.showLoader(false);
    }
  },

  async cancelActiveRide() {
    if (!this.state.activeRide) return;
    this.showLoader(true);
    try {
      // Fetch latest order status to prevent double-cancelling or cancelling an active trip
      const { data: latest, error: fetchError } = await supabaseClient
        .from('orders')
        .select('status')
        .eq('id', this.state.activeRide.id)
        .single();
      if (fetchError) throw fetchError;
      
      if (latest.status === 'in_transit' || latest.status === 'completed') {
        alert('This ride is already in transit or completed. Cancellation is locked.');
        window.location.reload();
        return;
      }
      
      const { error: cancelError } = await supabaseClient
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', this.state.activeRide.id);
      if (cancelError) throw cancelError;
      
      this.showToast('Ride request cancelled.');
      this.state.activeRide = null;
      window.location.reload();
    } catch (e) {
      console.error(e);
      alert('Failed to cancel ride: ' + (e.message || e));
    } finally {
      this.showLoader(false);
    }
  },

  async riderCancelTask() {
    const activeRide = this.state.activeRide;
    if (!activeRide) return;
    
    this.showLoader(true);
    try {
      const { data: latest, error: fetchError } = await supabaseClient
         .from('orders')
         .select('status')
         .eq('id', activeRide.id)
         .single();
      if (fetchError) throw fetchError;
      
      if (latest.status === 'in_transit' || latest.status === 'completed') {
        alert('Ride is already in transit or completed. Cancellation is locked.');
        window.location.reload();
        return;
      }
      
      // Release ride back to dispatcher queue
      const { error: cancelError } = await supabaseClient
        .from('orders')
        .update({ rider_id: null, status: 'pending' })
        .eq('id', activeRide.id);
      if (cancelError) throw cancelError;
      
      this.showToast('Ride task released.');
      window.location.reload();
    } catch (e) {
      console.error(e);
      alert('Failed to cancel task: ' + (e.message || e));
    } finally {
      this.showLoader(false);
    }
  },


  async checkActiveCustomerRide() {
    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .select(`
          *,
          rider:rider_id (
            full_name,
            phone,
            bike_registration
          )
        `)
        .eq('customer_id', this.state.currentUser.id)
        .in('status', ['pending', 'accepted', 'in_transit'])
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;

      const bookingBtn = document.getElementById('customer-btn-dispatch');

      if (data && data.length > 0) {
        if (bookingBtn) bookingBtn.disabled = true;
        const ride = data[0];
        this.state.activeRide = ride;
        this.renderCustomerRideOverlay(ride);
        this.listenToCustomerRideUpdates(ride.id);

        // Switch to ride view and draw active path
        this.switchView('ride');
        setTimeout(() => {
          const pickupCoords = this.getCoordinates(ride.pickup);
          const dropoffCoords = this.getCoordinates(ride.dropoff);
          this.drawActiveRoute(pickupCoords, dropoffCoords, 'customer');
        }, 300);
      } else {
        if (bookingBtn) bookingBtn.disabled = false;
        this.state.activeRide = null;
        const container = document.getElementById('customer-ride-status-container');
        if (container) container.classList.add('hidden');
        this.clearActiveRoute('customer');
      }
    } catch (err) {
      console.log('Error checking active ride:', err);
    }
  },

  renderCustomerRideOverlay(ride) {
    const container = document.getElementById('customer-ride-status-container');
    const badge = document.getElementById('customer-ride-badge');
    const serviceEl = document.getElementById('cust-ride-service');
    const pickupEl = document.getElementById('cust-ride-pickup');
    const dropoffEl = document.getElementById('cust-ride-dropoff');
    const driverBox = document.getElementById('cust-ride-driver-box');

    if (!container || !badge || !serviceEl || !pickupEl || !dropoffEl || !driverBox) return;

    serviceEl.innerText = this.formatServiceName(ride.service_type);
    pickupEl.innerText = this.cleanLocation(ride.pickup);
    dropoffEl.innerText = this.cleanLocation(ride.dropoff);

    badge.innerText = ride.status.toUpperCase();
    badge.className = 'badge';
    badge.classList.add(`badge-${ride.status}`);

    if (ride.status === 'accepted' || ride.status === 'in_transit') {
      driverBox.classList.remove('hidden');
      if (ride.rider) {
        const nameEl = document.getElementById('cust-driver-name');
        const phoneEl = document.getElementById('cust-driver-phone');
        const regEl = document.getElementById('cust-driver-reg');
        if (nameEl) nameEl.innerText = ride.rider.full_name;
        if (phoneEl) phoneEl.innerText = ride.rider.phone;
        if (regEl) regEl.innerText = ride.rider.bike_registration || 'N/A';
      }
    } else {
      driverBox.classList.add('hidden');
    }

    const otpBox = document.getElementById('cust-ride-otp-box');
    const otpCodeEl = document.getElementById('cust-ride-otp-code');
    if (ride.otp) {
      if (otpBox) otpBox.classList.remove('hidden');
      if (otpCodeEl) otpCodeEl.innerText = ride.otp;
    } else {
      if (otpBox) otpBox.classList.add('hidden');
    }

    // Toggle actions based on ride status (Report Issue replaces Cancel when in transit/completed)
    const actionsContainer = document.getElementById('cust-actions-container');
    if (actionsContainer) {
      if (ride.status === 'in_transit' || ride.status === 'completed') {
        const userName = this.state.currentUser ? this.state.currentUser.full_name : 'User';
        const emailSubject = `Ryzo Support Request - Order #${ride.id}`;
        const emailBody = `User: ${userName}%0AIssue Type: Ride Issue%0ADescription: `;
        const mailtoUrl = `mailto:supportcareryzo@gmail.com?subject=${encodeURIComponent(emailSubject)}&body=${emailBody}`;
        
        actionsContainer.innerHTML = `
          <a id="cust-btn-report-issue" href="${mailtoUrl}" onclick="RyzoApp.logSupportTicket('${ride.id}', 'ride', 'User triggered Report Issue from active ride overlay.')" class="btn-secondary btn-tactile" style="display: block; text-align: center; text-decoration: none; width: 100%; margin-top: 12px; background: rgba(255, 0, 60, 0.15); border: 1px solid var(--accent-cyan); color: white; padding: 10px;">
            Report Issue
          </a>
        `;
      } else {
        actionsContainer.innerHTML = `
          <button id="cust-btn-cancel-ride" class="btn-secondary btn-tactile" style="width: 100%; margin-top: 12px; background: rgba(220, 38, 38, 0.15); border: 1px solid rgb(220, 38, 38); color: rgb(248, 113, 113); padding: 10px;">
            Cancel Ride Request
          </button>
        `;
        const cancelBtn = document.getElementById('cust-btn-cancel-ride');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => this.cancelActiveRide());
        }
      }
    }

    // Live Rider Location & ETA display logic
    const etaBox = document.getElementById('cust-ride-eta-box');
    if ((ride.status === 'accepted' || ride.status === 'in_transit') && ride.rider_lat && ride.rider_lng) {
      this.updateRiderMarkerOnCustomerMap(ride.rider_lat, ride.rider_lng);

      // Estimate ETA
      const pickupCoords = [ride.pickup_lat, ride.pickup_lng];
      if (pickupCoords[0] && pickupCoords[1]) {
        const distMeters = this.getDistanceMeters(ride.rider_lat, ride.rider_lng, pickupCoords[0], pickupCoords[1]);
        const distKm = distMeters / 1000;
        const etaMinutes = Math.max(1, Math.round(distKm * 2 + 1)); // ~30 km/h average + 1 min buffer
        
        if (etaBox) {
          etaBox.classList.remove('hidden');
          etaBox.innerHTML = `<strong>ETA:</strong> Rider is about ${etaMinutes} mins away (${(distKm).toFixed(1)} km)`;
        }
      } else {
        if (etaBox) {
          etaBox.classList.remove('hidden');
          etaBox.innerHTML = `<strong>Rider Status:</strong> Live tracking active...`;
        }
      }
    } else {
      if (etaBox) etaBox.classList.add('hidden');
      this.clearRiderMarkerOnCustomerMap();
    }

    container.classList.remove('hidden');
  },


  listenToCustomerRideUpdates(rideId) {
    this.disconnectCustomerRideRealtime();

    this.state.customerChannel = supabaseClient
      .channel(`customer_ride_${rideId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'orders',
        filter: `id=eq.${rideId}`
      }, async (payload) => {
        console.log('Customer ride status update received:', payload.new);
        
        if (payload.new.status === 'completed') {
          this.showToast('Trip Completed! Please submit your feedback.');
          
          this.state.completedRideId = rideId;
          this.state.completedRiderId = payload.new.rider_id;
          this.state.completedType = 'ride';
          const ratingModal = document.getElementById('rating-modal');

          if (ratingModal) ratingModal.classList.remove('hidden');
          
          this.state.activeRide = null;
          const container = document.getElementById('customer-ride-status-container');
          if (container) container.classList.add('hidden');
          this.clearActiveRoute('customer');
          this.disconnectCustomerRideRealtime();
        } else {
          try {
            const { data: updatedRide, error } = await supabaseClient
              .from('orders')
              .select(`
                *,
                rider:rider_id (
                  full_name,
                  phone,
                  bike_registration
                )
              `)
              .eq('id', rideId)
              .single();

            if (error || !updatedRide) {
              console.warn('Real-time join query failed, falling back to payload data:', error);
              const fallbackRide = { ...payload.new };
              this.state.activeRide = fallbackRide;
              this.renderCustomerRideOverlay(fallbackRide);
            } else {
              if (!updatedRide.otp && payload.new.otp) {
                updatedRide.otp = payload.new.otp;
              }
              // Propagate real-time rider location coordinates from payload
              updatedRide.rider_lat = payload.new.rider_lat;
              updatedRide.rider_lng = payload.new.rider_lng;
              this.state.activeRide = updatedRide;
              this.renderCustomerRideOverlay(updatedRide);
            }

            const active = this.state.activeRide;
            if (active && active.pickup && active.dropoff) {
              const pickupCoords = this.getCoordinates(active.pickup);
              const dropoffCoords = this.getCoordinates(active.dropoff);
              this.drawActiveRoute(pickupCoords, dropoffCoords, 'customer');
            }
          } catch (e) {
            console.error('Error handling customer ride update:', e);
            this.state.activeRide = payload.new;
            this.renderCustomerRideOverlay(payload.new);
          }
        }
      })
      .subscribe();
  },

  disconnectCustomerRideRealtime() {
    if (this.state.customerChannel) {
      supabaseClient.removeChannel(this.state.customerChannel);
      this.state.customerChannel = null;
    }
  },

  // Dynamic Fare Calculation Overhaul - Hardcoded local market fareChart
  calculateFare(pickup, dropoff) {
    if (!pickup || !dropoff) return 0;
    
    const p = pickup.trim();
    const d = dropoff.trim();
    
    let fareValue = 0;
    
    if (p === d) {
      // Same location is a local market trip
      fareValue = fareChart['Local_Market'];
    } else if (p === 'Local Market' || d === 'Local Market') {
      fareValue = fareChart['Local_Market'];
    } else {
      const key1 = `${p}_${d}`;
      const key2 = `${d}_${p}`;
      
      if (fareChart[key1] !== undefined) {
        fareValue = fareChart[key1];
      } else if (fareChart[key2] !== undefined) {
        fareValue = fareChart[key2];
      } else {
        // Unsupported route combination
        fareValue = -1; 
      }
    }
    
    // Update the UI fare boxes
    const displayEl = document.getElementById('fare-estimate-display');
    const fareDisplayEl = document.getElementById('fare-display');
    
    if (fareValue === -1) {
      if (displayEl) displayEl.innerText = 'Route Not Supported';
      if (fareDisplayEl) fareDisplayEl.innerText = 'Route Not Supported';
      return 0;
    }
    
    if (displayEl) {
      displayEl.innerText = '₹' + fareValue;
    }
    if (fareDisplayEl) {
      fareDisplayEl.innerText = '₹' + fareValue;
    }
    
    return fareValue;
  },

  calculateFares() {
    const pickupEl = document.getElementById('customer-pickup');
    const dropoffEl = document.getElementById('customer-dropoff');
    if (!pickupEl || !dropoffEl) return;
    const pickup = pickupEl.value.trim();
    const dropoff = dropoffEl.value.trim();

    // Centering Map and marker updating logic
    if (this.maps.customer) {
      if (pickup && dropoff) {
        const fareTemp = this.calculateFare(pickup, dropoff);
        if (fareTemp > 0) {
          const pickupCoords = this.getCoordinates(pickup);
          const dropoffCoords = this.getCoordinates(dropoff);
          this.drawActiveRoute(pickupCoords, dropoffCoords, 'customer');
        } else {
          this.clearActiveRoute('customer');
          const pickupCoords = this.getCoordinates(pickup);
          const dropoffCoords = this.getCoordinates(dropoff);
          
          this.markers.customerPickup = L.marker(pickupCoords)
            .addTo(this.maps.customer)
            .bindPopup('Pickup Point')
            .openPopup();
            
          this.markers.customerDropoff = L.marker(dropoffCoords)
            .addTo(this.maps.customer)
            .bindPopup('Dropoff Destination');
            
          const group = new L.featureGroup([
            this.markers.customerPickup,
            this.markers.customerDropoff
          ]);
          this.maps.customer.fitBounds(group.getBounds().pad(0.15));
        }
      } else if (pickup) {
        this.clearActiveRoute('customer');
        const pickupCoords = this.getCoordinates(pickup);
        this.markers.customerPickup = L.marker(pickupCoords)
          .addTo(this.maps.customer)
          .bindPopup('Pickup Point')
          .openPopup();
        this.maps.customer.setView(pickupCoords, 14);
      } else if (dropoff) {
        this.clearActiveRoute('customer');
        const dropoffCoords = this.getCoordinates(dropoff);
        this.markers.customerDropoff = L.marker(dropoffCoords)
          .addTo(this.maps.customer)
          .bindPopup('Dropoff Destination')
          .openPopup();
        this.maps.customer.setView(dropoffCoords, 14);
      } else {
        this.clearActiveRoute('customer');
      }
    }

    if (!pickup || !dropoff) {
      const displayEl = document.getElementById('fare-estimate-display');
      if (displayEl) displayEl.innerText = '₹0';
      const fareDisplayEl = document.getElementById('fare-display');
      if (fareDisplayEl) fareDisplayEl.innerText = '₹0';
      return;
    }

    this.calculateFare(pickup, dropoff);
  },


  // (Leftover cart and food order methods removed)

  // ----------------------------------------------------
  // RIDER/TRANSPORTER DASHBOARD CONTROLLER
  // ----------------------------------------------------
  async loadRiderDashboard() {
    const userProfile = this.state.currentUser;

    const profileNameEl = document.getElementById('rider-profile-name');
    if (profileNameEl) profileNameEl.innerText = userProfile.full_name;
    const walletEl = document.getElementById('rider-wallet-balance');
    if (walletEl) walletEl.innerText = `₹${parseFloat(userProfile.wallet_balance).toFixed(2)}`;

    const dutySwitch = document.getElementById('rider-duty-switch');
    const statusDot = document.getElementById('rider-status-dot');
    const statusText = document.getElementById('rider-status-text');

    if (!userProfile.is_verified) {
      const alertEl = document.getElementById('rider-verification-alert');
      if (alertEl) alertEl.classList.remove('hidden');
      if (dutySwitch) {
        dutySwitch.disabled = true;
        dutySwitch.checked = false;
      }
      if (statusDot) statusDot.className = 'status-indicator status-offline';
      if (statusText) statusText.innerText = 'Unavailable (Unverified)';
    } else {
      const alertEl = document.getElementById('rider-verification-alert');
      if (alertEl) alertEl.classList.add('hidden');
      
      if (parseFloat(userProfile.wallet_balance) <= 0) {
        this.triggerOverdraftLockout(userProfile.wallet_balance);
        return;
      }
      
      if (!userProfile.rider_online) {
        userProfile.rider_online = true;
        this.handleRiderDutyToggle(true);
        return;
      }
      
      if (dutySwitch) {
        dutySwitch.disabled = true;
        dutySwitch.checked = true;
      }
      
      if (statusDot) statusDot.className = 'status-indicator status-online';
      if (statusText) statusText.innerText = 'Online & Active';
      this.connectRiderRealtime();
    }

    this.checkActiveRiderTask();
  },

  async handleRiderDutyToggle(isOnline) {
    if (parseFloat(this.state.currentUser.wallet_balance) <= 0) {
      this.showToast('Replenish wallet to switch duty online.');
      document.getElementById('rider-duty-switch').checked = false;
      return;
    }

    this.showLoader(true);
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .update({ rider_online: isOnline })
        .eq('id', this.state.currentUser.id)
        .select()
        .single();

      if (error) throw error;

      this.state.currentUser = data;
      this.loadRiderDashboard();
    } catch (e) {
      this.showToast('Failed to toggle duty availability.');
      document.getElementById('rider-duty-switch').checked = !isOnline;
    } finally {
      this.showLoader(false);
    }
  },

  connectRiderRealtime() {
    this.disconnectRiderRealtime();

    const emptyFeed = document.getElementById('rider-empty-feed');
    if (emptyFeed) {
      emptyFeed.innerHTML = `<p style="color:var(--accent-cyan); font-size: 0.85rem; animation: pulse 1.5s infinite;">Listening for local dispatcher feed...</p>`;
    }

    this.fetchPendingRides();

    this.state.realtimeChannel = supabaseClient
      .channel('rider_dispatch')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'orders'
      }, (payload) => {
        console.log('Ride realtime change observed:', payload);
        
        if (payload.eventType === 'INSERT') {
          if (payload.new.status === 'pending') {
            this.addRideToRiderFeed(payload.new);
          }
        } else if (payload.eventType === 'UPDATE') {
          if (payload.new.status === 'pending') {
            this.addRideToRiderFeed(payload.new);
          } else {
            this.removeRideFromRiderFeed(payload.new.id);
          }
        }
      })
      .subscribe();
  },

  disconnectRiderRealtime() {
    if (this.state.realtimeChannel) {
      supabaseClient.removeChannel(this.state.realtimeChannel);
      this.state.realtimeChannel = null;
    }
    const list = document.getElementById('incoming-order-list');
    if (list) {
      list.innerHTML = `
        <div id="rider-empty-feed" class="glass-card" style="text-align:center; padding: 40px 20px;">
          <p style="color:var(--text-muted); font-size: 0.85rem;">Toggle Online status to listen to nearby ride requests</p>
        </div>
      `;
    }
    const badge = document.getElementById('order-count-badge');
    if (badge) badge.innerText = '0 Active';
  },

  async fetchPendingRides() {
    try {
      // Anonymized query: select only pickup, dropoff, fare, timestamp (created_at), and coordinates
      const { data: rides, error: ridesErr } = await supabaseClient
        .from('orders')
        .select('id, pickup, dropoff, fare, created_at, pickup_lat, pickup_lng')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (ridesErr) throw ridesErr;

      const list = document.getElementById('incoming-order-list');
      if (list) {
        list.innerHTML = '';
      }

      const hasRides = rides && rides.length > 0;

      if (hasRides) {
        rides.forEach(ride => {
          if (!ride.pickup || !ride.dropoff) {
            console.log("Empty location payload inside dispatch feed for order:", ride);
          }
          this.addRideToRiderFeed(ride);
        });
      } else {
        if (list) {
          list.innerHTML = `
            <div id="rider-empty-feed" class="glass-card" style="text-align:center; padding: 40px 20px;">
              <p style="color:var(--text-muted); font-size: 0.85rem;">No ride requests available. Waiting...</p>
            </div>
          `;
        }
        const badge = document.getElementById('order-count-badge');
        if (badge) badge.innerText = '0 Active';
      }
    } catch (e) {
      console.error(e);
      this.showToast('Could not load incoming dispatch feed.');
    }
  },

  updateRiderBadgeCount() {
    const list = document.getElementById('incoming-order-list');
    const count = list.querySelectorAll('.ride-request-card').length;
    document.getElementById('order-count-badge').innerText = `${count} Active`;
  },

  async acceptRideAssignment(rideId) {
    if (this.state.activeRide) {
      this.showToast('You are already assigned to an active task.');
      return;
    }

    this.showLoader(true);
    const riderId = this.state.currentUser.id;

    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          rider_id: riderId,
          status: 'accepted'
        })
        .eq('id', rideId)
        .eq('status', 'pending')
        .is('rider_id', null)
        .select();

      if (error) throw error;

      if (data && data.length > 0) {
        this.showToast('Ride accepted! Proceed to pickup.');
        window.location.reload();
      } else {
        this.showToast('Assignment locked: Another transporter accepted this ride request first.');
        this.removeRideFromRiderFeed(rideId);
      }

    } catch (e) {
      console.error(e);
      this.showToast('Error accepting ride request.');
    } finally {
      this.showLoader(false);
    }
  },

  async checkActiveRiderTask() {
    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .select(`
          *,
          customer:customer_id (
            full_name,
            phone
          )
        `)
        .eq('rider_id', this.state.currentUser.id)
        .in('status', ['accepted', 'in_transit'])
        .limit(1);

      if (error) throw error;

      if (data && data.length > 0) {
        const ride = data[0];
        this.state.activeRide = ride;
        this.renderRiderTaskPanel(ride);
        this.disconnectRiderRealtime();
        this.startRiderLocationTracking(ride.id);

        setTimeout(() => {
          this.initRiderMap();
          const pickupCoords = this.getCoordinates(ride.pickup);
          const dropoffCoords = this.getCoordinates(ride.dropoff);
          this.drawActiveRoute(pickupCoords, dropoffCoords, 'rider');
        }, 300);
      } else {
        this.state.activeRide = null;
        this.stopRiderLocationTracking();
        const panel = document.getElementById('rider-accepted-order-panel');
        if (panel) panel.classList.add('hidden');
        if (this.state.currentUser.rider_online && parseFloat(this.state.currentUser.wallet_balance) > 0) {
          this.connectRiderRealtime();
        }
      }
    } catch (e) {
      console.log('Error checking active rider task:', e);
    }
  },

  startRiderLocationTracking(rideId) {
    if (this.state.riderLocationInterval) {
      clearInterval(this.state.riderLocationInterval);
    }

    const updatePosition = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          
          // Update order table with current rider position
          await supabaseClient
            .from('orders')
            .update({ rider_lat: lat, rider_lng: lng })
            .eq('id', rideId);
        },
        (err) => console.warn('Rider geolocation update error:', err),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    };

    // Update immediately and then every 10 seconds
    updatePosition();
    this.state.riderLocationInterval = setInterval(updatePosition, 10000);
  },

  stopRiderLocationTracking() {
    if (this.state.riderLocationInterval) {
      clearInterval(this.state.riderLocationInterval);
      this.state.riderLocationInterval = null;
    }
  },

  renderRiderTaskPanel(ride) {
    const titleEl = document.getElementById('rider-task-panel-title');
    if (titleEl) titleEl.innerText = 'Active Ride Task Assigned';

    const customerNameEl = document.getElementById('rider-task-customer-name');
    if (customerNameEl) customerNameEl.innerText = ride.customer ? ride.customer.full_name : 'Customer';

    const customerPhoneEl = document.getElementById('rider-task-customer-phone');
    if (customerPhoneEl) customerPhoneEl.innerText = ride.customer ? ride.customer.phone : 'N/A';

    // Show pickup and dropoff boxes (cleaned locations)
    const pickupBox = document.getElementById('rider-task-pickup-box');
    if (pickupBox) pickupBox.classList.remove('hidden');
    const pickupEl = document.getElementById('rider-task-pickup');
    if (pickupEl) pickupEl.innerText = this.cleanLocation(ride.pickup);

    const dropoffBox = document.getElementById('rider-task-dropoff-box');
    if (dropoffBox) dropoffBox.classList.remove('hidden');
    const dropoffEl = document.getElementById('rider-task-dropoff');
    if (dropoffEl) dropoffEl.innerText = this.cleanLocation(ride.dropoff);

    // Hide items box
    const itemsBox = document.getElementById('rider-task-items-box');
    if (itemsBox) itemsBox.classList.add('hidden');

    const fareEl = document.getElementById('rider-task-fare');
    if (fareEl) fareEl.innerText = `₹${ride.fare}`;

    // Hide payout box
    const payoutBox = document.getElementById('rider-task-payout-box');
    if (payoutBox) payoutBox.classList.add('hidden');

    // Hide admin alert
    const adminAlertEl = document.getElementById('rider-task-admin-alert');
    if (adminAlertEl) adminAlertEl.classList.add('hidden');

    // Extra details
    const extraBox = document.getElementById('rider-task-extra-box');
    if (extraBox) extraBox.classList.add('hidden');

    // Show and setup OTP verification box for Ride
    const otpVerificationBox = document.getElementById('rider-otp-verification-box');
    if (otpVerificationBox) {
      otpVerificationBox.classList.remove('hidden');
      const otpInput = document.getElementById('rider-otp-input');
      if (otpInput) otpInput.value = '';
      const statusText = document.getElementById('rider-verification-status-text');
      if (statusText) {
        if (ride.status === 'accepted') {
          statusText.innerText = 'Enter Customer OTP to Start Trip...';
        } else {
          statusText.innerText = 'Enter Customer OTP to End Trip...';
        }
      }
    }

    // Toggle completion buttons
    const btnTrip = document.getElementById('rider-btn-complete-trip');
    if (btnTrip) {
      btnTrip.classList.remove('hidden');
      btnTrip.disabled = true;
      if (ride.status === 'accepted') {
        btnTrip.innerText = 'Verify & Start Trip';
      } else {
        btnTrip.innerText = 'Verify & Complete Trip';
      }
    }

    // Toggle actions based on ride status (Report Issue replaces Cancel when in transit/completed)
    const actionsContainer = document.getElementById('rider-actions-container');
    if (actionsContainer) {
      if (ride.status === 'in_transit' || ride.status === 'completed') {
        const userName = this.state.currentUser ? this.state.currentUser.full_name : 'Transporter';
        const emailSubject = `Ryzo Support Request - Order #${ride.id}`;
        const emailBody = `User: ${userName}%0AIssue Type: Ride Issue%0ADescription: `;
        const mailtoUrl = `mailto:supportcareryzo@gmail.com?subject=${encodeURIComponent(emailSubject)}&body=${emailBody}`;
        
        actionsContainer.innerHTML = `
          <a id="rider-btn-report-issue" href="${mailtoUrl}" onclick="RyzoApp.logSupportTicket('${ride.id}', 'ride', 'Transporter triggered Report Issue from active task board.')" class="btn-secondary btn-tactile" style="display: block; text-align: center; text-decoration: none; width: 100%; margin-top: 12px; background: rgba(255, 0, 60, 0.15); border: 1px solid var(--accent-cyan); color: white; padding: 10px;">
            Report Issue
          </a>
        `;
      } else if (ride.status === 'pending') {
        actionsContainer.innerHTML = `
          <button id="rider-btn-cancel-task" class="btn-secondary btn-tactile" style="width: 100%; margin-top: 12px; background: rgba(220, 38, 38, 0.15); border: 1px solid rgb(220, 38, 38); color: rgb(248, 113, 113); padding: 10px;">
            Cancel Task
          </button>
        `;
        const cancelBtn = document.getElementById('rider-btn-cancel-task');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => this.riderCancelTask());
        }
      } else {
        actionsContainer.innerHTML = '';
      }
    }

    const panel = document.getElementById('rider-accepted-order-panel');

    if (panel) panel.classList.remove('hidden');

    // Trigger verification checks immediately
    this.checkVerificationRequirements();
  },

  async completeActiveRide() {
    if (!this.state.activeRide) return;
    
    this.showLoader(true);
    const rideId = this.state.activeRide.id;
    const otpInput = document.getElementById('rider-otp-input');
    const riderEnteredOtp = otpInput ? otpInput.value.trim().toString() : '';
    
    try {
      // 1. Fetch current ride status and OTP code directly from database for State Reconciliation
      const { data: rideData, error: fetchError } = await supabaseClient
        .from('orders')
        .select('status, otp, customer_id, rider_id')
        .eq('id', rideId)
        .single();

      if (fetchError) throw fetchError;
      
      // If the ride is already completed, abort to prevent duplicate payout/commission deduction
      if (rideData.status === 'completed') {
        throw new Error('This ride has already been completed.');
      }
      if (rideData.status === 'cancelled') {
        throw new Error('This ride has been cancelled.');
      }

      // 2. Strict OTP verification with type-casting and error logging (The "Bulletproof" Function logic)
      const storedOtp = String(rideData.otp).trim();
      const inputOtp = String(riderEnteredOtp).trim();

      if (storedOtp === inputOtp) {
        console.log("OTP Verified Successfully");
      } else {
        console.error("Mismatch! Stored:", storedOtp, "Received:", inputOtp);
        alert("Incorrect OTP code.");
        throw new Error("Incorrect OTP code.");
      }

      if (rideData.status === 'accepted') {
        // Start the trip: update status to 'in_transit' in Supabase
        const { error } = await supabaseClient
          .from('orders')
          .update({ status: 'in_transit' })
          .eq('id', rideId);

        if (error) throw error;

        this.showToast('Trip started successfully!');
        window.location.reload();
      } else if (rideData.status === 'in_transit') {
        // End the trip: update status to 'completed' in Supabase
        const { error: updateError } = await supabaseClient
          .from('orders')
          .update({ status: 'completed' })
          .eq('id', rideId);

        if (updateError) throw updateError;

        this.stopRiderLocationTracking();
        this.showToast('Ride completed successfully!');
        window.location.reload();
      }
    } catch (e) {
      console.error(e);
      alert('Failed to complete ride transaction: ' + (e.message || e));
    } finally {
      this.showLoader(false);
    }
  },


  addRideToRiderFeed(ride) {
    if (document.getElementById(`ride-card-${ride.id}`)) return;

    const list = document.getElementById('incoming-order-list');
    
    const emptyState = document.getElementById('rider-empty-feed');
    if (emptyState) emptyState.remove();

    const card = document.createElement('div');
    card.id = `ride-card-${ride.id}`;
    card.className = 'glass-card ride-request-card';
    card.style.position = 'relative';
    card.style.marginBottom = '12px';

    const serviceName = this.formatServiceName(ride.service_type);

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size:0.95rem; font-weight:700; color:white;">${serviceName}</span>
        <span style="color:var(--accent-cyan); font-weight:800; font-size:1.1rem;">₹${ride.fare}</span>
      </div>
      <div style="font-size:0.8rem; display:flex; flex-direction:column; gap:4px; margin-bottom:12px;">
        <div><strong style="color:var(--text-secondary);">Pickup:</strong> ${this.cleanLocation(ride.pickup || '')}</div>
        <div><strong style="color:var(--text-secondary);">Dropoff:</strong> ${this.cleanLocation(ride.dropoff || '')}</div>
      </div>

      <button class="btn-primary btn-tactile" onclick="RyzoApp.acceptRideAssignment('${ride.id}')" style="padding:10px 16px; font-size:0.85rem;">
        ACCEPT DISPATCH
      </button>
    `;

    if (list) list.prepend(card);
    this.updateRiderBadgeCount();
  },

  removeRideFromRiderFeed(rideId) {
    const card = document.getElementById(`ride-card-${rideId}`);
    if (card) {
      card.remove();
      this.updateRiderBadgeCount();
      
      const list = document.getElementById('incoming-order-list');
      if (list && list.children.length === 0) {
        list.innerHTML = `
          <div id="rider-empty-feed" class="glass-card" style="text-align:center; padding: 40px 20px;">
            <p style="color:var(--text-muted); font-size: 0.85rem;">No ride requests available in your area. Waiting...</p>
          </div>
        `;
      }
    }
  },



  async submitWithdrawalRequest() {
    const upiEl = document.getElementById('withdrawal-upi');
    const amountEl = document.getElementById('withdrawal-amount');
    if (!upiEl || !amountEl) return;
    
    const upiId = upiEl.value.trim();
    const amount = parseFloat(amountEl.value);
    
    if (!upiId || isNaN(amount) || amount <= 0) {
      this.showToast('Please enter a valid UPI ID and amount.');
      return;
    }
    
    const upiPattern = /^[a-zA-Z0-9.-]+@[a-zA-Z]+$/;
    if (!upiPattern.test(upiId)) {
      this.showToast('Invalid UPI ID format (e.g. name@upi).');
      return;
    }
    
    this.showLoader(true);
    try {
      const { error } = await supabaseClient
        .from('withdrawal_requests')
        .insert([{
          rider_id: this.state.currentUser.id,
          upi_id: upiId,
          amount: amount,
          status: 'pending'
        }]);
        
      if (error) throw error;
      
      this.showToast('Withdrawal request submitted successfully!');
      upiEl.value = '';
      amountEl.value = '';
    } catch (e) {
      console.error(e);
      alert('Failed to submit withdrawal request: ' + (e.message || e));
    } finally {
      this.showLoader(false);
    }
  },


  triggerOverdraftLockout(balance) {
    this.disconnectRiderRealtime();
    
    document.getElementById('lockout-wallet-display').innerText = `₹${parseFloat(balance).toFixed(2)}`;
    document.getElementById('lockout-overlay').classList.remove('hidden');

    const dutySwitch = document.getElementById('rider-duty-switch');
    dutySwitch.checked = false;
    dutySwitch.disabled = true;

    const statusDot = document.getElementById('rider-status-dot');
    statusDot.className = 'status-indicator status-offline';
    document.getElementById('rider-status-text').innerText = 'Locked Out (Overdraft)';
  },

  async replenishWallet() {
    this.showLoader(true);
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .update({ wallet_balance: 100.0 })
        .eq('id', this.state.currentUser.id)
        .select()
        .single();

      if (error) throw error;

      this.state.currentUser = data;
      
      document.getElementById('lockout-overlay').classList.add('hidden');
      this.showToast('Wallet replenished! ₹100.00 loaded.');
      
      this.loadRiderDashboard();
    } catch (e) {
      this.showToast('Verification failed. Try again.');
    } finally {
      this.showLoader(false);
    }
  },

  // ----------------------------------------------------
  // UTILITY HELPER FUNCTIONS
  // ----------------------------------------------------
  formatServiceName(serviceKey) {
    const serviceNames = {
      'bike': 'Bike Taxi',
      'bike_ride': 'Bike Taxi'
    };
    return serviceNames[serviceKey] || 'Bike Taxi';
  },


  showLoader(show) {
    const loader = document.getElementById('loading-overlay');
    if (show) {
      loader.classList.remove('hidden');
    } else {
      loader.classList.add('hidden');
    }
  },

  showToast(message) {
    const toast = document.getElementById('toast-container');
    document.getElementById('toast-message').innerText = message;
    toast.classList.add('show');
    
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.hideToast();
    }, 3500);
  },

  hideToast() {
    const toast = document.getElementById('toast-container');
    toast.classList.remove('show');
  },

  async loadCustomerHistory() {
    const historyList = document.getElementById('history-list');
    if (!historyList) return;

    historyList.innerHTML = `
      <div style="text-align:center; padding: 40px 20px;">
        <div class="spinner" style="margin: 0 auto 12px auto; width: 24px; height: 24px;"></div>
        <p style="color:var(--text-muted); font-size: 0.85rem;">Loading your history...</p>
      </div>
    `;

    try {
      const customerId = this.state.currentUser.id;

      // Query completed orders for the customer
      const { data: rides, error } = await supabaseClient
        .from('orders')
        .select('*')
        .eq('customer_id', customerId)
        .eq('status', 'completed');

      if (error) throw error;

      // Query ratings to see which completed orders have already been rated
      const rideIds = (rides || []).map(r => r.id);
      let ratedOrderIds = new Set();
      if (rideIds.length > 0) {
        const { data: ratingsData, error: ratingsError } = await supabaseClient
          .from('ratings')
          .select('order_id')
          .in('order_id', rideIds);
        
        if (!ratingsError && ratingsData) {
          ratedOrderIds = new Set(ratingsData.map(item => item.order_id));
        }
      }

      // Combine and format
      const historyItems = [];

      // Process rides
      (rides || []).forEach(ride => {
        historyItems.push({
          id: ride.id,
          rider_id: ride.rider_id,
          date: new Date(ride.created_at),
          type: this.formatServiceName(ride.service_type || 'bike'),
          details: `${this.cleanLocation(ride.pickup || '')} ➔ ${this.cleanLocation(ride.dropoff || '')}`,
          status: ride.status,
          price: ride.fare,
          isRated: ratedOrderIds.has(ride.id)
        });
      });

      // Sort reverse-chronological (newest first)
      historyItems.sort((a, b) => b.date - a.date);

      if (historyItems.length === 0) {
        historyList.innerHTML = `
          <div class="glass-card" style="text-align:center; padding: 40px 20px;">
            <p style="color:var(--text-muted); font-size: 0.85rem;">You haven't completed any rides yet.</p>
          </div>
        `;
        return;
      }

      historyList.innerHTML = '';
      historyItems.forEach(item => {
        const dateStr = item.date.toLocaleString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });

        const card = document.createElement('div');
        card.className = 'glass-card';
        card.style.marginBottom = '12px';
        card.style.borderLeft = `4px solid var(--accent-blue)`;
        
        let rateButtonHtml = '';
        if (!item.isRated) {
          rateButtonHtml = `
            <div style="margin-top: 10px; text-align: right; border-top:1px dashed var(--border-light); padding-top:8px;">
              <button class="btn-primary btn-tactile" onclick="RyzoApp.openRatingFromHistory('${item.id}', '${item.rider_id}')" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 4px;">
                Rate Your Ride
              </button>
            </div>
          `;
        } else {
          rateButtonHtml = `
            <div style="margin-top: 10px; text-align: right; border-top:1px dashed var(--border-light); padding-top:8px; font-size: 0.75rem; color: var(--accent-cyan);">
              ✓ Rated
            </div>
          `;
        }

        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
            <div>
              <span style="font-weight:700; font-size:0.95rem; color:white;">${item.type}</span>
              <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${dateStr}</div>
            </div>
            <div style="text-align:right;">
              <span style="font-weight:800; font-size:1.1rem; color:var(--text-primary);">₹${item.price}</span>
              <div style="margin-top:4px;"><span class="badge badge-${item.status}">${item.status.toUpperCase()}</span></div>
            </div>
          </div>
          <div style="font-size:0.8rem; color:var(--text-muted); border-top:1px dashed var(--border-light); padding-top:8px; margin-top:8px;">
            ${item.details}
          </div>
          ${rateButtonHtml}
        `;
        historyList.appendChild(card);
      });

    } catch (e) {
      console.error('Failed to load history:', e);
      historyList.innerHTML = `
        <div class="glass-card" style="text-align:center; padding: 40px 20px; border-left: 4px solid var(--alert-magenta);">
          <p style="color:var(--alert-magenta); font-weight:700; font-size: 0.85rem;">Failed to load history.</p>
          <button class="btn-primary btn-tactile" onclick="RyzoApp.loadCustomerHistory()" style="margin-top:12px; padding:6px 12px; font-size:0.8rem;">Try Again</button>
        </div>
      `;
    }
  },

  throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      } else {
        RyzoApp.showToast('Please wait 30 seconds before booking again.');
      }
    }
  },

  showHelpModal() {
    const modal = document.getElementById('help-modal');
    if (modal) modal.classList.remove('hidden');
  },

  hideHelpModal() {
    const modal = document.getElementById('help-modal');
    if (modal) modal.classList.add('hidden');
    const form = document.getElementById('help-support-form');
    if (form) form.reset();
  },

  async submitSupportTicket() {
    const categoryEl = document.getElementById('help-issue-category');
    const messageEl = document.getElementById('help-issue-message');
    if (!categoryEl || !messageEl) return;
    
    const category = categoryEl.value;
    const message = messageEl.value.trim();
    if (!message) {
      this.showToast('Please describe the problem.');
      return;
    }
    
    this.showLoader(true);
    try {
      const { error } = await supabaseClient
        .from('support_tickets')
        .insert([{
          user_id: this.state.currentUser.id,
          category: category,
          message: message,
          status: 'open'
        }]);
        
      if (error) throw error;
      
      this.showToast('Ticket submitted successfully! Support will contact you.');
      this.hideHelpModal();
    } catch (e) {
      console.error('Failed to submit support ticket:', e);
      this.showToast('Failed to submit report. Please try again.');
    } finally {
      this.showLoader(false);
    }
  },

  showLoadWalletModal() {
    const modal = document.getElementById('load-wallet-modal');
    if (modal) modal.classList.remove('hidden');
  },

  hideLoadWalletModal() {
    const modal = document.getElementById('load-wallet-modal');
    if (modal) modal.classList.add('hidden');
    const form = document.getElementById('load-wallet-form');
    if (form) form.reset();
  },

  async submitTopUpRequest() {
    const amountEl = document.getElementById('load-wallet-amount');
    const upiIdEl = document.getElementById('load-wallet-upi-id');
    if (!amountEl || !upiIdEl) return;
    
    const amount = parseInt(amountEl.value, 10);
    const upiId = upiIdEl.value.trim();
    
    if (!amount || amount <= 0) {
      this.showToast('Please enter a valid amount.');
      return;
    }
    
    if (!upiId) {
      this.showToast('Please enter your 12-digit UPI UTR Transaction ID.');
      return;
    }
    
    const utrPattern = /^[a-zA-Z0-9]{8,18}$/;
    if (!utrPattern.test(upiId)) {
      this.showToast('Invalid Transaction ID (UTR) format.');
      return;
    }
    
    this.showLoader(true);
    try {
      const { error } = await supabaseClient
        .from('wallet_topups')
        .insert([{
          user_id: this.state.currentUser.id,
          amount: amount,
          upi_id: upiId,
          status: 'pending'
        }]);
        
      if (error) throw error;
      
      this.showToast('Top-up request submitted successfully! Pending verification.');
      this.hideLoadWalletModal();
    } catch (e) {
      console.error('Failed to submit top-up request:', e);
      this.showToast('Failed to submit request. Please try again.');
    } finally {
      this.showLoader(false);
    }
  },

  async logSupportTicket(orderId, category, message) {
    try {
      const payload = {
        user_id: this.state.currentUser.id,
        category: category,
        message: message,
        status: 'open'
      };
      if (orderId && orderId !== 'N/A') {
        payload.order_id = orderId;
      }
      await supabaseClient
        .from('support_tickets')
        .insert([payload]);
      console.log('Support ticket logged automatically:', payload);
    } catch (e) {
      console.error('Failed to log support ticket:', e);
    }
  },

  async contactSupport(issueType) {
    const rideId = this.state.activeRide ? this.state.activeRide.id : 'N/A';
    const userName = this.state.currentUser ? this.state.currentUser.full_name : 'User';
    const emailSubject = `Ryzo Support Request - Order #${rideId}`;
    const emailBody = `User: ${userName}%0AIssue Type: ${issueType}%0ADescription: `;
    const mailtoUrl = `mailto:supportcareryzo@gmail.com?subject=${encodeURIComponent(emailSubject)}&body=${emailBody}`;
    
    await this.logSupportTicket(rideId, issueType.toLowerCase(), `User triggered support contact. Subject: ${emailSubject}`);
    window.location.href = mailtoUrl;
  },

  switchAdminView(subView) {
    const viewTopups = document.getElementById('admin-view-topups');
    const viewTickets = document.getElementById('admin-view-tickets');
    const tabTopups = document.getElementById('admin-tab-topups');
    const tabTickets = document.getElementById('admin-tab-tickets');

    if (subView === 'topups') {
      if (viewTopups) viewTopups.classList.remove('hidden');
      if (viewTickets) viewTickets.classList.add('hidden');
      if (tabTopups) {
        tabTopups.style.background = 'var(--card-charcoal)';
        tabTopups.style.color = 'white';
      }
      if (tabTickets) {
        tabTickets.style.background = 'transparent';
        tabTickets.style.color = 'var(--text-muted)';
      }
    } else if (subView === 'tickets') {
      if (viewTopups) viewTopups.classList.add('hidden');
      if (viewTickets) viewTickets.classList.remove('hidden');
      if (tabTopups) {
        tabTopups.style.background = 'transparent';
        tabTopups.style.color = 'var(--text-muted)';
      }
      if (tabTickets) {
        tabTickets.style.background = 'var(--card-charcoal)';
        tabTickets.style.color = 'white';
      }
    }
  },

  async loadAdminDashboard() {
    this.showLoader(true);
    try {
      // 1. Fetch pending wallet topups
      const { data: topups, error: topupsError } = await supabaseClient
        .from('wallet_topups')
        .select(`
          *,
          profiles:user_id (
            full_name,
            email,
            role
          )
        `)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (topupsError) throw topupsError;

      const topupsList = document.getElementById('admin-pending-list');
      const topupsCount = document.getElementById('admin-pending-count');
      const emptyState = document.getElementById('admin-empty-state');

      if (topupsList) {
        topupsList.querySelectorAll('.topup-card').forEach(el => el.remove());
        if (topupsCount) topupsCount.innerText = `${topups.length} Requests`;

        if (topups.length === 0) {
          if (emptyState) emptyState.classList.remove('hidden');
        } else {
          if (emptyState) emptyState.classList.add('hidden');
          topups.forEach(req => {
            const card = document.createElement('div');
            card.className = 'glass-card topup-card glow-cyan';
            card.style.marginTop = '12px';
            card.style.padding = '16px';
            card.style.textAlign = 'left';

            const userName = req.profiles ? req.profiles.full_name : 'Unknown User';
            const userEmail = req.profiles ? req.profiles.email : 'No Email';
            const userRole = req.profiles ? req.profiles.role.toUpperCase() : 'USER';
            const dateStr = new Date(req.created_at).toLocaleString();

            card.innerHTML = `
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                <div>
                  <h4 style="font-size:0.95rem; font-weight:700; color:white;">${userName}</h4>
                  <span style="font-size:0.7rem; color:var(--accent-cyan); font-weight:700;">${userRole}</span>
                  <p style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${userEmail}</p>
                </div>
                <div style="text-align:right;">
                  <span style="font-size:1.2rem; font-weight:800; color:var(--accent-cyan);">₹${parseFloat(req.amount).toFixed(2)}</span>
                </div>
              </div>
              <div style="background:var(--card-charcoal); border:1px solid var(--border-light); padding:10px; border-radius:8px; margin-bottom:12px;">
                <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">UPI Transaction ID (UTR)</div>
                <div style="font-family:monospace; color:white; font-size:0.9rem; margin-top:2px; word-break:break-all;">${req.upi_id}</div>
                <div style="font-size:0.65rem; color:var(--text-muted); margin-top:4px;">Submitted: ${dateStr}</div>
              </div>
              <div style="display:flex; gap:8px;">
                <button class="btn-primary btn-tactile approve-btn" style="flex:1; margin-top:0; padding:8px 12px; font-size:0.8rem; background:rgba(0, 240, 255, 0.2); border:1px solid var(--accent-cyan); color:white;">Approve</button>
                <button class="btn-secondary btn-tactile reject-btn" style="flex:1; margin-top:0; padding:8px 12px; font-size:0.8rem; background:rgba(255, 0, 122, 0.1); border:1px solid var(--alert-magenta); color:rgb(248, 113, 113);">Reject</button>
              </div>
            `;

            card.querySelector('.approve-btn').addEventListener('click', () => this.verifyTopUp(req.id, 'approved'));
            card.querySelector('.reject-btn').addEventListener('click', () => this.verifyTopUp(req.id, 'rejected'));
            topupsList.appendChild(card);
          });
        }
      }

      // 2. Fetch Support Tickets
      const { data: tickets, error: ticketsError } = await supabaseClient
        .from('support_tickets')
        .select(`
          *,
          profiles:user_id (
            full_name,
            email,
            role
          ),
          orders:order_id (
            pickup,
            dropoff,
            fare,
            status
          )
        `)
        .order('created_at', { ascending: false });

      if (ticketsError) throw ticketsError;

      const ticketsList = document.getElementById('admin-tickets-list');
      const ticketsCount = document.getElementById('admin-tickets-count');
      const ticketsEmpty = document.getElementById('admin-tickets-empty');

      if (ticketsList) {
        ticketsList.querySelectorAll('.ticket-card').forEach(el => el.remove());
        if (ticketsCount) ticketsCount.innerText = `${tickets.length} Tickets`;

        if (tickets.length === 0) {
          if (ticketsEmpty) ticketsEmpty.classList.remove('hidden');
        } else {
          if (ticketsEmpty) ticketsEmpty.classList.add('hidden');
          tickets.forEach(ticket => {
             const card = document.createElement('div');
             card.className = 'glass-card ticket-card glow-magenta';
             card.style.marginTop = '12px';
             card.style.padding = '16px';
             card.style.textAlign = 'left';

             const userName = ticket.profiles ? ticket.profiles.full_name : 'Unknown';
             const userEmail = ticket.profiles ? ticket.profiles.email : 'No Email';
             const userRole = ticket.profiles ? ticket.profiles.role.toUpperCase() : 'USER';
             const dateStr = new Date(ticket.created_at).toLocaleString();
             
             let rideDetailHtml = '';
             if (ticket.orders) {
               rideDetailHtml = `
                 <div style="margin-top:10px; padding:8px; border-radius:6px; background:rgba(255, 255, 255, 0.02); border:1px solid var(--border-light); font-size:0.75rem;">
                   <span style="color:var(--accent-cyan); font-weight:700;">Ride Details:</span>
                   <div><strong>Pickup:</strong> ${this.cleanLocation(ticket.orders.pickup)}</div>
                   <div><strong>Dropoff:</strong> ${this.cleanLocation(ticket.orders.dropoff)}</div>
                   <div><strong>Fare:</strong> ₹${ticket.orders.fare} | <strong>Status:</strong> ${ticket.orders.status.toUpperCase()}</div>
                 </div>
               `;
             }

             card.innerHTML = `
               <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                 <div>
                   <h4 style="font-size:0.95rem; font-weight:700; color:white;">${userName}</h4>
                   <span style="font-size:0.7rem; color:var(--alert-magenta); font-weight:700;">${userRole}</span>
                   <p style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${userEmail}</p>
                 </div>
                 <div style="text-align:right;">
                   <span class="badge" style="font-size:0.7rem; background:rgba(255,255,255,0.03); border:1px solid var(--border-light); color:var(--text-muted);">${ticket.status.toUpperCase()}</span>
                 </div>
               </div>
               <div style="font-size:0.85rem; color:white; background:rgba(0,0,0,0.2); padding:10px; border-radius:8px; border:1px solid var(--border-light); margin-top:8px; white-space:pre-wrap;">
                 <strong style="color:var(--text-muted); font-size:0.7rem; display:block; text-transform:uppercase; margin-bottom:4px;">Message / Issue:</strong>
                 ${ticket.message}
               </div>
               ${rideDetailHtml}
               <div style="font-size:0.65rem; color:var(--text-muted); margin-top:8px; text-align:right;">Logged: ${dateStr}</div>
             `;
             ticketsList.appendChild(card);
          });
        }
      }

    } catch (e) {
      console.error('Failed to load admin dashboard:', e);
      this.showToast('Failed to load dashboard data.');
    } finally {
      this.showLoader(false);
    }
  },

  async verifyTopUp(topupId, status) {
    this.showLoader(true);
    try {
      const { error } = await supabaseClient
        .from('wallet_topups')
        .update({ status: status })
        .eq('id', topupId);

      if (error) throw error;

      this.showToast(`Request ${status === 'approved' ? 'approved & credited' : 'rejected'} successfully.`);
      this.loadAdminDashboard();
    } catch (e) {
      console.error(`Failed to ${status} topup:`, e);
      this.showToast(`Failed to update top-up status: ${e.message}`);
    } finally {
      this.showLoader(false);
    }
  }
};

// Expose RyzoApp globally for inline HTML event handlers
window.RyzoApp = RyzoApp;

// Start the APP once DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  RyzoApp.init();
});
